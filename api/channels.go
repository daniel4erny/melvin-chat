package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

type MessagePreview struct {
	Text        string `json:"text"`
	CreatedAt   int64  `json:"createdAt"`
	DisplayName string `json:"displayName"`
	Kind        string `json:"kind"`
	FileName    string `json:"fileName"`
}

type Channel struct {
	ID          int64           `json:"id"`
	Name        string          `json:"name"`
	Topic       string          `json:"topic"`
	Visibility  string          `json:"visibility"`
	OwnerID     int64           `json:"ownerId"`
	CreatedAt   int64           `json:"createdAt"`
	CategoryID  int64           `json:"categoryId"`
	Kind        string          `json:"kind"`
	Slowmode    int             `json:"slowmode"`
	Role        string          `json:"role"`
	MemberCount int             `json:"memberCount"`
	Unread      int             `json:"unread"`
	DM          bool            `json:"dm"`
	Group       bool            `json:"group"`
	Peer        *User           `json:"peer,omitempty"`
	Peers       []User          `json:"peers,omitempty"`
	LastMessage *MessagePreview `json:"lastMessage,omitempty"`
}

type Category struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	Position  int    `json:"position"`
	CreatedBy int64  `json:"createdBy"`
}

type ChannelMember struct {
	User
	Role   string `json:"role"`
	Online bool   `json:"online"`
}

func (d *DB) MemberRole(channelID, userID int64) (string, bool, error) {
	var role string
	err := d.sql.QueryRow("SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?", channelID, userID).Scan(&role)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", false, nil
		}
		return "", false, err
	}
	return role, true, nil
}

func (d *DB) ChannelByID(id, viewerID int64) (Channel, error) {
	var c Channel
	var lastRead int64
	err := d.sql.QueryRow(`
		SELECT c.id, c.name, c.topic, c.visibility, c.owner_id, c.created_at,
		       COALESCE(c.category_id, 0), c.kind, c.slowmode,
		       COALESCE((SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id), 0),
		       COALESCE((SELECT cm.role FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?), ''),
		       COALESCE((SELECT cm.last_read_id FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ?), 0)
		FROM channels c WHERE c.id = ?`, viewerID, viewerID, id).
		Scan(&c.ID, &c.Name, &c.Topic, &c.Visibility, &c.OwnerID, &c.CreatedAt, &c.CategoryID, &c.Kind, &c.Slowmode, &c.MemberCount, &c.Role, &lastRead)
	if err != nil {
		return Channel{}, errNotFound
	}
	if viewerID > 0 && lastRead >= 0 {
		_ = d.sql.QueryRow(
			"SELECT COUNT(*) FROM messages WHERE channel_id = ? AND id > ? AND deleted = 0 AND user_id <> ?",
			id, lastRead, viewerID,
		).Scan(&c.Unread)
	}
	c.DM = c.Visibility == "direct"
	if c.DM && viewerID > 0 {
		c.Peers = d.dmPeers(id, viewerID)
		c.Group = len(c.Peers) > 1
		if len(c.Peers) == 1 {
			peer := c.Peers[0]
			c.Peer = &peer
		}
	}
	c.LastMessage = d.lastPreview(id)
	return c, nil
}

// dmPeers returns the other participants of a direct or group conversation.
func (d *DB) dmPeers(channelID, viewerID int64) []User {
	rows, err := d.sql.Query(
		"SELECT "+userCols+" FROM channel_members cm JOIN users u ON u.id = cm.user_id WHERE cm.channel_id = ? AND cm.user_id <> ? ORDER BY u.display_name COLLATE NOCASE",
		channelID, viewerID,
	)
	if err != nil {
		return nil
	}
	defer rows.Close()
	peers := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err == nil {
			peers = append(peers, u)
		}
	}
	return peers
}

// dmPeer returns the other participant of a one-to-one conversation.
func (d *DB) dmPeer(channelID, viewerID int64) *User {
	peers := d.dmPeers(channelID, viewerID)
	if len(peers) != 1 {
		return nil
	}
	return &peers[0]
}

// FindOrCreateDM returns the one-to-one conversation between two users,
// creating it on first use. The hidden name keeps the pair unique.
func (d *DB) FindOrCreateGroupDM(userID int64, peerIDs []int64) (Channel, error) {
	unique := map[int64]bool{userID: true}
	ids := []int64{userID}
	for _, id := range peerIDs {
		if id <= 0 || unique[id] {
			continue
		}
		unique[id] = true
		ids = append(ids, id)
	}
	if len(ids) < 2 {
		return Channel{}, errors.New("vyber alespoň jednoho člověka")
	}
	if len(ids) > 10 {
		return Channel{}, errors.New("skupinová zpráva může mít nejvýš 10 lidí")
	}
	if len(ids) == 2 {
		return d.FindOrCreateDM(userID, ids[0]+ids[1]-userID)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	parts := make([]string, 0, len(ids)+1)
	parts = append(parts, "gdm")
	for _, id := range ids {
		parts = append(parts, strconv.FormatInt(id, 10))
	}
	name := strings.Join(parts, ":")
	now := nowMS()
	tx, err := d.sql.Begin()
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		"INSERT OR IGNORE INTO channels (name, topic, visibility, owner_id, kind, created_at) VALUES (?, '', 'direct', ?, 'text', ?)",
		name, userID, now,
	); err != nil {
		return Channel{}, err
	}
	var id int64
	if err := tx.QueryRow("SELECT id FROM channels WHERE visibility = 'direct' AND name = ?", name).Scan(&id); err != nil {
		return Channel{}, err
	}
	for _, uid := range ids {
		if _, err := tx.Exec(
			"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
			id, uid, now,
		); err != nil {
			return Channel{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return d.ChannelByID(id, userID)
}

func (d *DB) FindOrCreateDM(userID, peerID int64) (Channel, error) {
	if userID == peerID {
		return Channel{}, errors.New("nemůžeš psát sám sobě")
	}
	lo, hi := userID, peerID
	if lo > hi {
		lo, hi = hi, lo
	}
	name := fmt.Sprintf("dm:%d:%d", lo, hi)
	tx, err := d.sql.Begin()
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		"INSERT OR IGNORE INTO channels (name, topic, visibility, owner_id, created_at) VALUES (?, '', 'direct', ?, ?)",
		name, userID, nowMS(),
	); err != nil {
		return Channel{}, err
	}
	var id int64
	if err := tx.QueryRow("SELECT id FROM channels WHERE visibility = 'direct' AND name = ?", name).Scan(&id); err != nil {
		return Channel{}, err
	}
	for _, uid := range []int64{userID, peerID} {
		if _, err := tx.Exec(
			"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
			id, uid, nowMS(),
		); err != nil {
			return Channel{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return d.ChannelByID(id, userID)
}

func (d *DB) lastPreview(channelID int64) *MessagePreview {
	var p MessagePreview
	err := d.sql.QueryRow(`
		SELECT m.text, m.created_at, u.display_name,
		       CASE WHEN m.sticker_id IS NOT NULL AND m.sticker_id <> '' THEN 'sticker' ELSE COALESCE(a.kind, '') END,
		       CASE WHEN m.sticker_id IS NOT NULL AND m.sticker_id <> '' THEN COALESCE(NULLIF(s.emoji, ''), s.name, '') ELSE COALESCE(a.name, '') END
		FROM messages m
		JOIN users u ON u.id = m.user_id
		LEFT JOIN attachments a ON a.id = m.attachment_id
		LEFT JOIN stickers s ON s.id = m.sticker_id
		WHERE m.channel_id = ? AND m.deleted = 0
		ORDER BY m.id DESC LIMIT 1`, channelID).
		Scan(&p.Text, &p.CreatedAt, &p.DisplayName, &p.Kind, &p.FileName)
	if err != nil {
		return nil
	}
	return &p
}

func (d *DB) ListChannels(userID int64) ([]Channel, error) {
	rows, err := d.sql.Query(`
		SELECT c.id, c.name, c.topic, c.visibility, c.owner_id, c.created_at,
		       COALESCE(c.category_id, 0), c.kind, c.slowmode, cm.role, cm.last_read_id,
		       (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = c.id),
		       (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted = 0 AND m.id > cm.last_read_id AND m.user_id <> ?)
		FROM channels c
		JOIN channel_members cm ON cm.channel_id = c.id
		WHERE cm.user_id = ?
		ORDER BY COALESCE((SELECT MAX(m.id) FROM messages m WHERE m.channel_id = c.id AND m.deleted = 0), 0) DESC, c.id DESC`,
		userID, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	channels := []Channel{}
	for rows.Next() {
		var c Channel
		var lastRead int64
		if err := rows.Scan(&c.ID, &c.Name, &c.Topic, &c.Visibility, &c.OwnerID, &c.CreatedAt, &c.CategoryID, &c.Kind, &c.Slowmode, &c.Role, &lastRead, &c.MemberCount, &c.Unread); err != nil {
			return nil, err
		}
		c.DM = c.Visibility == "direct"
		if c.DM {
			c.Peers = d.dmPeers(c.ID, userID)
			c.Group = len(c.Peers) > 1
			if len(c.Peers) == 1 {
				peer := c.Peers[0]
				c.Peer = &peer
			}
		}
		c.LastMessage = d.lastPreview(c.ID)
		channels = append(channels, c)
	}
	return channels, rows.Err()
}

func (d *DB) CreateChannel(name, topic, visibility, kind string, categoryID int64, slowmode int, ownerID int64, memberIDs []int64) (Channel, error) {
	now := nowMS()
	tx, err := d.sql.Begin()
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()

	var category any
	if categoryID > 0 {
		category = categoryID
	}
	res, err := tx.Exec(
		"INSERT INTO channels (name, topic, visibility, kind, category_id, slowmode, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		name, topic, visibility, kind, category, slowmode, ownerID, now,
	)
	if err != nil {
		return Channel{}, err
	}
	id, _ := res.LastInsertId()
	if _, err := tx.Exec(
		"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)",
		id, ownerID, now,
	); err != nil {
		return Channel{}, err
	}
	if visibility == "public" {
		if _, err := tx.Exec(
			"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) SELECT ?, id, 'member', ? FROM users",
			id, now,
		); err != nil {
			return Channel{}, err
		}
	} else {
		for _, uid := range memberIDs {
			if uid == ownerID {
				continue
			}
			if _, err := tx.Exec(
				"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
				id, uid, now,
			); err != nil {
				return Channel{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return d.ChannelByID(id, ownerID)
}

func (d *DB) UpdateChannel(id int64, name, topic, visibility, kind *string, categoryID *int64, slowmode *int, memberIDs []int64, replaceMembers bool) (Channel, error) {
	c, err := d.ChannelByID(id, 0)
	if err != nil {
		return Channel{}, err
	}
	if name != nil {
		c.Name = *name
	}
	if topic != nil {
		c.Topic = *topic
	}
	if visibility != nil {
		c.Visibility = *visibility
	}
	if kind != nil {
		c.Kind = *kind
	}
	if categoryID != nil {
		c.CategoryID = *categoryID
	}
	if slowmode != nil {
		c.Slowmode = *slowmode
	}
	var category any
	if c.CategoryID > 0 {
		category = c.CategoryID
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return Channel{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		"UPDATE channels SET name = ?, topic = ?, visibility = ?, kind = ?, category_id = ?, slowmode = ? WHERE id = ?",
		c.Name, c.Topic, c.Visibility, c.Kind, category, c.Slowmode, id,
	); err != nil {
		return Channel{}, err
	}
	if c.Visibility == "public" {
		if _, err := tx.Exec(
			"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) SELECT ?, id, 'member', ? FROM users",
			id, nowMS(),
		); err != nil {
			return Channel{}, err
		}
	}
	if replaceMembers && c.Visibility == "private" {
		keep := map[int64]bool{c.OwnerID: true}
		for _, uid := range memberIDs {
			keep[uid] = true
		}
		rows, err := tx.Query("SELECT user_id FROM channel_members WHERE channel_id = ?", id)
		if err != nil {
			return Channel{}, err
		}
		var remove []int64
		for rows.Next() {
			var uid int64
			if err := rows.Scan(&uid); err == nil && !keep[uid] {
				remove = append(remove, uid)
			}
		}
		rows.Close()
		for _, uid := range remove {
			if _, err := tx.Exec("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?", id, uid); err != nil {
				return Channel{}, err
			}
		}
		for uid := range keep {
			if _, err := tx.Exec(
				"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
				id, uid, nowMS(),
			); err != nil {
				return Channel{}, err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return Channel{}, err
	}
	return d.ChannelByID(id, 0)
}

func (d *DB) DeleteChannel(id int64) error {
	_, err := d.sql.Exec("DELETE FROM channels WHERE id = ?", id)
	return err
}

// ---- channel categories ----

func scanCategory(s scanner) (Category, error) {
	var c Category
	if err := s.Scan(&c.ID, &c.Name, &c.Position, &c.CreatedBy); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Category{}, errNotFound
		}
		return Category{}, err
	}
	return c, nil
}

func (d *DB) CategoryByID(id int64) (Category, error) {
	return scanCategory(d.sql.QueryRow("SELECT id, name, position, created_by FROM channel_categories WHERE id = ?", id))
}

func (d *DB) ListCategories() ([]Category, error) {
	rows, err := d.sql.Query("SELECT id, name, position, created_by FROM channel_categories ORDER BY position, name COLLATE NOCASE, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	categories := []Category{}
	for rows.Next() {
		c, err := scanCategory(rows)
		if err != nil {
			return nil, err
		}
		categories = append(categories, c)
	}
	return categories, rows.Err()
}

func (d *DB) CreateCategory(name string, createdBy int64) (Category, error) {
	var position int
	if err := d.sql.QueryRow("SELECT COALESCE(MAX(position), -1) + 1 FROM channel_categories").Scan(&position); err != nil {
		return Category{}, err
	}
	res, err := d.sql.Exec(
		"INSERT INTO channel_categories (name, position, created_by, created_at) VALUES (?, ?, ?, ?)",
		name, position, createdBy, nowMS(),
	)
	if err != nil {
		return Category{}, err
	}
	id, _ := res.LastInsertId()
	return d.CategoryByID(id)
}

func (d *DB) UpdateCategory(id int64, name string) (Category, error) {
	res, err := d.sql.Exec("UPDATE channel_categories SET name = ? WHERE id = ?", name, id)
	if err != nil {
		return Category{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Category{}, errNotFound
	}
	return d.CategoryByID(id)
}

// DeleteCategory removes the folder but keeps its channels; they become
// uncategorised instead of disappearing.
func (d *DB) DeleteCategory(id int64) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("UPDATE channels SET category_id = NULL WHERE category_id = ?", id); err != nil {
		return err
	}
	res, err := tx.Exec("DELETE FROM channel_categories WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return tx.Commit()
}

func (d *DB) ReorderCategories(ids []int64) error {
	tx, err := d.sql.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for position, id := range ids {
		if _, err := tx.Exec("UPDATE channel_categories SET position = ? WHERE id = ?", position, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) ChannelMemberIDs(id int64) ([]int64, error) {
	rows, err := d.sql.Query("SELECT user_id FROM channel_members WHERE channel_id = ?", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var uid int64
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		ids = append(ids, uid)
	}
	return ids, rows.Err()
}

func (d *DB) ListChannelMembers(id int64) ([]ChannelMember, error) {
	rows, err := d.sql.Query(`
		SELECT `+userCols+`, cm.role
		FROM channel_members cm JOIN users u ON u.id = cm.user_id
		WHERE cm.channel_id = ?
		ORDER BY CASE cm.role WHEN 'owner' THEN 0 ELSE 1 END, u.display_name COLLATE NOCASE`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	members := []ChannelMember{}
	for rows.Next() {
		var m ChannelMember
		var admin, banned int
		var bannedUntil, timeoutUntil sql.NullInt64
		var settings string
		if err := rows.Scan(
			&m.ID, &m.Username, &m.DisplayName, &m.AvatarColor, &m.Bio, &admin,
			&m.StatusEmoji, &m.StatusText, &banned, &m.BanReason, &bannedUntil,
			&settings, &m.CreatedAt, &m.AvatarID, &m.Pronouns, &m.Location, &m.Website,
			&m.LastSeen, &timeoutUntil, &m.TimeoutReason, &m.Role,
		); err != nil {
			return nil, err
		}
		m.Admin = admin != 0
		m.Banned = banned != 0
		if bannedUntil.Valid {
			v := bannedUntil.Int64
			m.BannedUntil = &v
		}
		if timeoutUntil.Valid {
			v := timeoutUntil.Int64
			m.TimeoutUntil = &v
		}
		m.Settings = decodeSettings(settings)
		members = append(members, m)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	users := make([]User, len(members))
	for i := range members {
		users[i] = members[i].User
	}
	if err := d.hydrateUsers(users); err != nil {
		return nil, err
	}
	for i := range members {
		members[i].User = users[i]
	}
	return members, nil
}

func (d *DB) MarkRead(channelID, userID, messageID int64) error {
	_, err := d.sql.Exec(
		"UPDATE channel_members SET last_read_id = MAX(last_read_id, ?) WHERE channel_id = ? AND user_id = ?",
		messageID, channelID, userID,
	)
	return err
}

func (d *DB) LatestMessageID(channelID int64) int64 {
	var id int64
	_ = d.sql.QueryRow("SELECT COALESCE(MAX(id), 0) FROM messages WHERE channel_id = ? AND deleted = 0", channelID).Scan(&id)
	return id
}

// ---- handlers ----

func (a *App) listChannels(w http.ResponseWriter, r *http.Request, u User) {
	channels, err := a.db.ListChannels(u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se načíst kanály")
		return
	}
	categories, err := a.db.ListCategories()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se načíst kategorie")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"channels": channels, "categories": categories})
}

type channelInput struct {
	Name       string  `json:"name"`
	Topic      string  `json:"topic"`
	Visibility string  `json:"visibility"`
	Kind       string  `json:"kind"`
	CategoryID int64   `json:"categoryId"`
	Slowmode   int     `json:"slowmode"`
	MemberIDs  []int64 `json:"memberIds"`
}

func validChannelKind(kind string) bool {
	return kind == "text" || kind == "voice"
}

func validSlowmode(seconds int) bool {
	switch seconds {
	case 0, 5, 10, 30, 60, 120, 300, 600, 1800, 3600:
		return true
	}
	return false
}

func (a *App) createChannel(w http.ResponseWriter, r *http.Request, u User) {
	var in channelInput
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	in.Name = strings.TrimSpace(strings.TrimPrefix(in.Name, "#"))
	in.Topic = strings.TrimSpace(in.Topic)
	if len(in.Name) < 1 || len(in.Name) > 40 {
		writeErr(w, http.StatusBadRequest, "Název kanálu musí mít 1–40 znaků")
		return
	}
	if in.Visibility != "private" {
		in.Visibility = "public"
	}
	if in.Kind == "" {
		in.Kind = "text"
	}
	if !validChannelKind(in.Kind) {
		writeErr(w, http.StatusBadRequest, "Neplatný typ kanálu")
		return
	}
	if in.Kind == "voice" {
		in.Slowmode = 0
	}
	if !validSlowmode(in.Slowmode) {
		writeErr(w, http.StatusBadRequest, "Neplatné zpomalení")
		return
	}
	if len(in.Topic) > 160 {
		writeErr(w, http.StatusBadRequest, "Téma je moc dlouhé")
		return
	}
	if in.CategoryID > 0 {
		if _, err := a.db.CategoryByID(in.CategoryID); err != nil {
			writeErr(w, http.StatusBadRequest, "Kategorie neexistuje")
			return
		}
	} else {
		in.CategoryID = 0
	}
	ch, err := a.db.CreateChannel(in.Name, in.Topic, in.Visibility, in.Kind, in.CategoryID, in.Slowmode, u.ID, in.MemberIDs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se vytvořit kanál")
		return
	}
	a.notifyChannelsChanged(ch.ID)
	writeJSON(w, http.StatusOK, map[string]any{"channel": ch})
}

func (a *App) getChannel(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	role, member, err := a.db.MemberRole(id, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	ch, err := a.db.ChannelByID(id, u.ID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Kanál neexistuje")
		return
	}
	ch.Role = role
	members, err := a.db.ListChannelMembers(id)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se načíst členy")
		return
	}
	online := a.hub.onlineSet()
	for i := range members {
		members[i].Online = online[members[i].ID]
	}
	writeJSON(w, http.StatusOK, map[string]any{"channel": ch, "members": members})
}

func (a *App) updateChannel(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	role, member, err := a.db.MemberRole(id, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	if existing, err := a.db.ChannelByID(id, u.ID); err == nil && existing.DM {
		writeErr(w, http.StatusBadRequest, "Přímé konverzace nejde upravovat")
		return
	}
	if role != "owner" && !a.can(u, PermManageChannels) {
		writeErr(w, http.StatusForbidden, "Kanál může upravit jen vlastník nebo role se správou kanálů")
		return
	}
	var in struct {
		Name       *string  `json:"name"`
		Topic      *string  `json:"topic"`
		Visibility *string  `json:"visibility"`
		Kind       *string  `json:"kind"`
		CategoryID *int64   `json:"categoryId"`
		Slowmode   *int     `json:"slowmode"`
		MemberIDs  *[]int64 `json:"memberIds"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	if in.Name != nil {
		n := strings.TrimSpace(strings.TrimPrefix(*in.Name, "#"))
		if len(n) < 1 || len(n) > 40 {
			writeErr(w, http.StatusBadRequest, "Název kanálu musí mít 1–40 znaků")
			return
		}
		in.Name = &n
	}
	if in.Topic != nil {
		t := strings.TrimSpace(*in.Topic)
		if len(t) > 160 {
			writeErr(w, http.StatusBadRequest, "Téma je moc dlouhé")
			return
		}
		in.Topic = &t
	}
	if in.Visibility != nil && *in.Visibility != "public" && *in.Visibility != "private" {
		writeErr(w, http.StatusBadRequest, "Neplatná viditelnost")
		return
	}
	if in.Kind != nil && !validChannelKind(*in.Kind) {
		writeErr(w, http.StatusBadRequest, "Neplatný typ kanálu")
		return
	}
	if in.Slowmode != nil && !validSlowmode(*in.Slowmode) {
		writeErr(w, http.StatusBadRequest, "Neplatné zpomalení")
		return
	}
	if in.CategoryID != nil {
		if *in.CategoryID < 0 {
			writeErr(w, http.StatusBadRequest, "Neplatná kategorie")
			return
		}
		if *in.CategoryID > 0 {
			if _, err := a.db.CategoryByID(*in.CategoryID); err != nil {
				writeErr(w, http.StatusBadRequest, "Kategorie neexistuje")
				return
			}
		}
	}
	oldMembers, _ := a.db.ChannelMemberIDs(id)
	var memberIDs []int64
	if in.MemberIDs != nil {
		memberIDs = *in.MemberIDs
	}
	ch, err := a.db.UpdateChannel(id, in.Name, in.Topic, in.Visibility, in.Kind, in.CategoryID, in.Slowmode, memberIDs, in.MemberIDs != nil)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se upravit kanál")
		return
	}
	a.notifyChannelsChanged(id)
	a.hub.BroadcastUsers(oldMembers, map[string]any{"type": "channels:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"channel": ch})
}

func (a *App) deleteChannel(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	role, member, err := a.db.MemberRole(id, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	if existing, err := a.db.ChannelByID(id, u.ID); err == nil && existing.DM {
		writeErr(w, http.StatusBadRequest, "Přímé konverzace nejde mazat")
		return
	}
	if role != "owner" && !a.can(u, PermManageChannels) {
		writeErr(w, http.StatusForbidden, "Kanál může smazat jen vlastník nebo role se správou kanálů")
		return
	}
	members, _ := a.db.ChannelMemberIDs(id)
	attachmentIDs := a.db.ChannelAttachmentIDs(id)
	if err := a.db.DeleteChannel(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se smazat kanál")
		return
	}
	for _, attID := range attachmentIDs {
		a.removeAttachmentFile(attID)
	}
	a.hub.BroadcastUsers(members, map[string]any{"type": "channels:changed"})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (d *DB) ChannelAttachmentIDs(channelID int64) []string {
	rows, err := d.sql.Query("SELECT id FROM attachments WHERE channel_id = ?", channelID)
	if err != nil {
		return nil
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	return ids
}

func (a *App) leaveChannel(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	role, member, err := a.db.MemberRole(id, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	if role == "owner" {
		writeErr(w, http.StatusBadRequest, "Vlastník nemůže opustit kanál, může ho jen smazat")
		return
	}
	ch, err := a.db.ChannelByID(id, u.ID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Kanál neexistuje")
		return
	}
	if ch.Visibility == "public" {
		writeErr(w, http.StatusBadRequest, "Z veřejného kanálu nejde odejít")
		return
	}
	if err := a.db.RemoveMember(id, u.ID); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se odejít z kanálu")
		return
	}
	a.notifyChannelsChanged(id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) markRead(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	_, member, err := a.db.MemberRole(id, u.ID)
	if err != nil || !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	var body struct {
		MessageID int64 `json:"messageId"`
	}
	_ = readJSON(r, &body)
	if body.MessageID <= 0 {
		body.MessageID = a.db.LatestMessageID(id)
	}
	if err := a.db.MarkRead(id, u.ID, body.MessageID); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se označit jako přečtené")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (d *DB) RemoveMember(channelID, userID int64) error {
	_, err := d.sql.Exec("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ? AND role <> 'owner'", channelID, userID)
	return err
}

func (a *App) createDM(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		UserID  int64   `json:"userId"`
		UserIDs []int64 `json:"userIds"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	ids := in.UserIDs
	if len(ids) == 0 && in.UserID > 0 {
		ids = []int64{in.UserID}
	}
	seen := map[int64]bool{}
	clean := []int64{}
	for _, id := range ids {
		if id <= 0 || id == u.ID || seen[id] {
			continue
		}
		seen[id] = true
		target, err := a.db.UserByID(id)
		if err != nil {
			writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
			return
		}
		if target.Banned {
			writeErr(w, http.StatusBadRequest, "Tomuto uživateli nejde napsat")
			return
		}
		clean = append(clean, id)
	}
	if len(clean) == 0 {
		writeErr(w, http.StatusBadRequest, "Vyber alespoň jednoho člověka")
		return
	}
	ch, err := a.db.FindOrCreateGroupDM(u.ID, clean)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.notifyChannelsChanged(ch.ID)
	writeJSON(w, http.StatusOK, map[string]any{"channel": ch})
}

func (a *App) notifyChannelsChanged(channelID int64) {
	members, err := a.db.ChannelMemberIDs(channelID)
	if err != nil {
		return
	}
	a.hub.BroadcastUsers(members, map[string]any{"type": "channels:changed"})
}

// ---- category handlers ----

func (a *App) listCategories(w http.ResponseWriter, r *http.Request, u User) {
	categories, err := a.db.ListCategories()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Kategorie se nepodařilo načíst")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"categories": categories})
}

func (a *App) createCategory(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	name := strings.TrimSpace(in.Name)
	if len(name) < 1 || len(name) > 40 {
		writeErr(w, http.StatusBadRequest, "Název kategorie musí mít 1–40 znaků")
		return
	}
	categories, err := a.db.ListCategories()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Kategorie se nepodařilo načíst")
		return
	}
	if len(categories) >= 30 {
		writeErr(w, http.StatusBadRequest, "Moc kategorií")
		return
	}
	category, err := a.db.CreateCategory(name, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Kategorii se nepodařilo vytvořit")
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "channels:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"category": category})
}

func (a *App) updateCategory(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	category, err := a.db.CategoryByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Kategorie neexistuje")
		return
	}
	if category.CreatedBy != u.ID && !a.can(u, PermManageChannels) {
		writeErr(w, http.StatusForbidden, "Kategorii může upravit jen její autor, admin nebo role se správou kanálů")
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	name := strings.TrimSpace(in.Name)
	if len(name) < 1 || len(name) > 40 {
		writeErr(w, http.StatusBadRequest, "Název kategorie musí mít 1–40 znaků")
		return
	}
	category, err = a.db.UpdateCategory(id, name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Kategorii se nepodařilo upravit")
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "channels:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"category": category})
}

func (a *App) deleteCategory(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	category, err := a.db.CategoryByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Kategorie neexistuje")
		return
	}
	if category.CreatedBy != u.ID && !a.can(u, PermManageChannels) {
		writeErr(w, http.StatusForbidden, "Kategorii může smazat jen její autor, admin nebo role se správou kanálů")
		return
	}
	if err := a.db.DeleteCategory(id); err != nil {
		writeErr(w, http.StatusInternalServerError, "Kategorii se nepodařilo smazat")
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "channels:changed"})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) reorderCategories(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		IDs []int64 `json:"ids"`
	}
	if err := readJSON(r, &in); err != nil || len(in.IDs) == 0 {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	for _, id := range in.IDs {
		category, err := a.db.CategoryByID(id)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "Kategorie neexistuje")
			return
		}
		if category.CreatedBy != u.ID && !a.can(u, PermManageChannels) {
			writeErr(w, http.StatusForbidden, "Kategorie může přeskládat jen její autor, admin nebo role se správou kanálů")
			return
		}
	}
	if err := a.db.ReorderCategories(in.IDs); err != nil {
		writeErr(w, http.StatusInternalServerError, "Kategorie se nepodařilo přeskládat")
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "channels:changed"})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
