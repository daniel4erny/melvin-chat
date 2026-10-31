package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

type Attachment struct {
	ID         string  `json:"id"`
	UploaderID int64   `json:"uploaderId"`
	Name       string  `json:"name"`
	Mime       string  `json:"mime"`
	Size       int64   `json:"size"`
	Kind       string  `json:"kind"`
	Duration   float64 `json:"duration"`
	CreatedAt  int64   `json:"createdAt"`
}

type Reaction struct {
	Emoji string `json:"emoji"`
	Count int    `json:"count"`
	Mine  bool   `json:"mine"`
}

type Message struct {
	ID         int64       `json:"id"`
	ChannelID  int64       `json:"channelId"`
	User       User        `json:"user"`
	Text       string      `json:"text"`
	CreatedAt  int64       `json:"createdAt"`
	EditedAt   *int64      `json:"editedAt,omitempty"`
	Deleted    bool        `json:"deleted"`
	Attachment *Attachment `json:"attachment,omitempty"`
	Poll       *Poll       `json:"poll,omitempty"`
	ReplyTo    *int64      `json:"replyTo,omitempty"`
	Reactions  []Reaction  `json:"reactions"`
}

type baseMessage struct {
	id           int64
	channelID    int64
	userID       int64
	text         string
	attachmentID sql.NullString
	pollID       sql.NullInt64
	replyTo      sql.NullInt64
	createdAt    int64
	editedAt     sql.NullInt64
	deleted      int
	user         User
}

const messageSelect = `
	SELECT m.id, m.channel_id, m.user_id, m.text, m.attachment_id, m.poll_id, m.reply_to,
	       m.created_at, m.edited_at, m.deleted,
	       u.username, u.display_name, u.avatar_color, u.bio, u.is_admin, u.settings, u.created_at
	FROM messages m JOIN users u ON u.id = m.user_id`

func scanBaseMessage(s scanner) (baseMessage, error) {
	var b baseMessage
	var admin int
	var settings string
	err := s.Scan(
		&b.id, &b.channelID, &b.userID, &b.text, &b.attachmentID, &b.pollID, &b.replyTo,
		&b.createdAt, &b.editedAt, &b.deleted,
		&b.user.Username, &b.user.DisplayName, &b.user.AvatarColor, &b.user.Bio, &admin, &settings, &b.user.CreatedAt,
	)
	if err != nil {
		return b, err
	}
	b.user.ID = b.userID
	b.user.Admin = admin != 0
	b.user.Settings = decodeSettings(settings)
	return b, nil
}

func placeholders(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

func toAny(ids []int64) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

func toAnyStrings(ids []string) []any {
	out := make([]any, len(ids))
	for i, id := range ids {
		out[i] = id
	}
	return out
}

func (d *DB) hydrateMessages(rows []baseMessage, viewerID int64) ([]Message, error) {
	messages := make([]Message, 0, len(rows))
	if len(rows) == 0 {
		return messages, nil
	}
	msgIDs := make([]int64, 0, len(rows))
	attachmentIDs := []string{}
	pollIDs := []int64{}
	for _, b := range rows {
		msgIDs = append(msgIDs, b.id)
		if b.attachmentID.Valid && b.attachmentID.String != "" {
			attachmentIDs = append(attachmentIDs, b.attachmentID.String)
		}
		if b.pollID.Valid {
			pollIDs = append(pollIDs, b.pollID.Int64)
		}
	}

	attachments := map[string]*Attachment{}
	if len(attachmentIDs) > 0 {
		q := "SELECT id, uploader_id, name, mime, size, kind, duration, created_at FROM attachments WHERE id IN (" + placeholders(len(attachmentIDs)) + ")"
		r, err := d.sql.Query(q, toAnyStrings(attachmentIDs)...)
		if err != nil {
			return nil, err
		}
		for r.Next() {
			var at Attachment
			if err := r.Scan(&at.ID, &at.UploaderID, &at.Name, &at.Mime, &at.Size, &at.Kind, &at.Duration, &at.CreatedAt); err != nil {
				r.Close()
				return nil, err
			}
			cpy := at
			attachments[at.ID] = &cpy
		}
		r.Close()
	}

	polls, err := d.loadPolls(pollIDs, viewerID)
	if err != nil {
		return nil, err
	}

	reactions := map[int64][]Reaction{}
	q := "SELECT message_id, emoji, COUNT(*), COALESCE(SUM(user_id = ?), 0) FROM reactions WHERE message_id IN (" +
		placeholders(len(msgIDs)) + ") GROUP BY message_id, emoji ORDER BY emoji"
	args := append([]any{viewerID}, toAny(msgIDs)...)
	r, err := d.sql.Query(q, args...)
	if err != nil {
		return nil, err
	}
	for r.Next() {
		var mid int64
		var emoji string
		var count, mine int
		if err := r.Scan(&mid, &emoji, &count, &mine); err != nil {
			r.Close()
			return nil, err
		}
		reactions[mid] = append(reactions[mid], Reaction{Emoji: emoji, Count: count, Mine: mine > 0})
	}
	r.Close()

	for _, b := range rows {
		m := Message{
			ID:        b.id,
			ChannelID: b.channelID,
			User:      b.user,
			Text:      b.text,
			CreatedAt: b.createdAt,
			Deleted:   b.deleted != 0,
			Reactions: reactions[b.id],
		}
		if m.Reactions == nil {
			m.Reactions = []Reaction{}
		}
		if b.editedAt.Valid {
			v := b.editedAt.Int64
			m.EditedAt = &v
		}
		if b.replyTo.Valid {
			v := b.replyTo.Int64
			m.ReplyTo = &v
		}
		if m.Deleted {
			m.Text = ""
		} else {
			if b.attachmentID.Valid {
				m.Attachment = attachments[b.attachmentID.String]
			}
			if b.pollID.Valid {
				m.Poll = polls[b.pollID.Int64]
			}
		}
		messages = append(messages, m)
	}
	return messages, nil
}

func (d *DB) ListMessages(channelID, beforeID int64, limit int, viewerID int64) ([]Message, bool, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	q := messageSelect + " WHERE m.channel_id = ? AND (? = 0 OR m.id < ?) ORDER BY m.id DESC LIMIT ?"
	rows, err := d.sql.Query(q, channelID, beforeID, beforeID, limit+1)
	if err != nil {
		return nil, false, err
	}
	base := []baseMessage{}
	for rows.Next() {
		b, err := scanBaseMessage(rows)
		if err != nil {
			rows.Close()
			return nil, false, err
		}
		base = append(base, b)
	}
	rows.Close()
	hasMore := len(base) > limit
	if hasMore {
		base = base[:limit]
	}
	for i, j := 0, len(base)-1; i < j; i, j = i+1, j-1 {
		base[i], base[j] = base[j], base[i]
	}
	msgs, err := d.hydrateMessages(base, viewerID)
	return msgs, hasMore, err
}

func (d *DB) MessagesByIDs(ids []int64, viewerID int64) ([]Message, error) {
	if len(ids) == 0 {
		return []Message{}, nil
	}
	rows, err := d.sql.Query(messageSelect+" WHERE m.id IN ("+placeholders(len(ids))+") ORDER BY m.id", toAny(ids)...)
	if err != nil {
		return nil, err
	}
	base := []baseMessage{}
	for rows.Next() {
		b, err := scanBaseMessage(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		base = append(base, b)
	}
	rows.Close()
	return d.hydrateMessages(base, viewerID)
}

func (d *DB) GetMessage(id, viewerID int64) (Message, error) {
	rows, err := d.sql.Query(messageSelect+" WHERE m.id = ?", id)
	if err != nil {
		return Message{}, err
	}
	var base []baseMessage
	for rows.Next() {
		b, err := scanBaseMessage(rows)
		if err != nil {
			rows.Close()
			return Message{}, err
		}
		base = append(base, b)
	}
	rows.Close()
	if len(base) == 0 {
		return Message{}, errNotFound
	}
	msgs, err := d.hydrateMessages(base, viewerID)
	if err != nil {
		return Message{}, err
	}
	return msgs[0], nil
}

func (d *DB) AttachmentAvailable(id string, userID int64) (bool, error) {
	var uploader int64
	var messageID sql.NullInt64
	err := d.sql.QueryRow("SELECT uploader_id, message_id FROM attachments WHERE id = ?", id).Scan(&uploader, &messageID)
	if err != nil {
		return false, err
	}
	return uploader == userID && !messageID.Valid, nil
}

var errMessageEmpty = errors.New("Zpráva je prázdná")

func (d *DB) CreateMessage(channelID, userID int64, text string, attachmentID *string, pollID *int64, replyTo *int64) (Message, error) {
	if strings.TrimSpace(text) == "" && attachmentID == nil && pollID == nil {
		return Message{}, errMessageEmpty
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return Message{}, err
	}
	defer tx.Rollback()
	if err := tx.QueryRow("SELECT 1 FROM channel_members WHERE channel_id = ? AND user_id = ?", channelID, userID).Scan(new(int)); err != nil {
		return Message{}, errors.New("Do tohoto kanálu nemáš přístup")
	}
	if replyTo != nil {
		var exists int
		if err := tx.QueryRow("SELECT 1 FROM messages WHERE id = ? AND channel_id = ?", *replyTo, channelID).Scan(&exists); err != nil {
			return Message{}, errors.New("Odpovídaná zpráva neexistuje")
		}
	}
	res, err := tx.Exec(
		"INSERT INTO messages (channel_id, user_id, text, attachment_id, poll_id, reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		channelID, userID, text, attachmentID, pollID, replyTo, nowMS(),
	)
	if err != nil {
		return Message{}, err
	}
	msgID, _ := res.LastInsertId()
	if attachmentID != nil {
		r, err := tx.Exec("UPDATE attachments SET channel_id = ?, message_id = ? WHERE id = ? AND uploader_id = ? AND message_id IS NULL",
			channelID, msgID, *attachmentID, userID)
		if err != nil {
			return Message{}, err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return Message{}, errors.New("Příloha už je použitá nebo neexistuje")
		}
	}
	if err := tx.Commit(); err != nil {
		return Message{}, err
	}
	return d.GetMessage(msgID, userID)
}

func (d *DB) DeleteMessage(id, userID int64, isAdmin bool) (int64, *string, error) {
	var channelID, author int64
	var attachmentID sql.NullString
	err := d.sql.QueryRow("SELECT channel_id, user_id, attachment_id FROM messages WHERE id = ? AND deleted = 0", id).
		Scan(&channelID, &author, &attachmentID)
	if err != nil {
		return 0, nil, errNotFound
	}
	if author != userID && !isAdmin {
		return 0, nil, errors.New("Tuhle zprávu nemůžeš smazat")
	}
	if _, err := d.sql.Exec("UPDATE messages SET deleted = 1, text = '' WHERE id = ?", id); err != nil {
		return 0, nil, err
	}
	_, _ = d.sql.Exec("DELETE FROM reactions WHERE message_id = ?", id)
	var attID *string
	if attachmentID.Valid {
		v := attachmentID.String
		attID = &v
		_, _ = d.sql.Exec("DELETE FROM attachments WHERE id = ?", v)
	}
	return channelID, attID, nil
}

func (d *DB) ToggleReaction(messageID, userID int64, emoji string) (int64, []Reaction, error) {
	var channelID int64
	var deleted int
	if err := d.sql.QueryRow("SELECT channel_id, deleted FROM messages WHERE id = ?", messageID).Scan(&channelID, &deleted); err != nil {
		return 0, nil, errNotFound
	}
	if deleted != 0 {
		return 0, nil, errors.New("Zpráva je smazaná")
	}
	var exists int
	err := d.sql.QueryRow("SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji).Scan(&exists)
	if err == nil {
		_, err = d.sql.Exec("DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?", messageID, userID, emoji)
	} else {
		_, err = d.sql.Exec("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)", messageID, userID, emoji)
	}
	if err != nil {
		return 0, nil, err
	}
	rows, err := d.sql.Query(
		"SELECT emoji, COUNT(*), COALESCE(SUM(user_id = ?), 0) FROM reactions WHERE message_id = ? GROUP BY emoji ORDER BY emoji",
		userID, messageID,
	)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()
	out := []Reaction{}
	for rows.Next() {
		var r Reaction
		var mine int
		if err := rows.Scan(&r.Emoji, &r.Count, &mine); err != nil {
			return 0, nil, err
		}
		r.Mine = mine > 0
		out = append(out, r)
	}
	return channelID, out, rows.Err()
}

func (d *DB) SearchMessages(channelID int64, query string, viewerID int64) ([]Message, error) {
	rows, err := d.sql.Query(
		"SELECT id FROM messages WHERE channel_id = ? AND deleted = 0 AND text LIKE ? ORDER BY id DESC LIMIT 50",
		channelID, "%"+query+"%",
	)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	return d.MessagesByIDs(ids, viewerID)
}

// ---- handlers ----

func (a *App) listMessages(w http.ResponseWriter, r *http.Request, u User) {
	channelID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný kanál")
		return
	}
	if _, member, _ := a.db.MemberRole(channelID, u.ID); !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	var before int64
	if v := r.URL.Query().Get("before"); v != "" {
		before, _ = strconv.ParseInt(v, 10, 64)
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	msgs, hasMore, err := a.db.ListMessages(channelID, before, limit, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se načíst zprávy")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "hasMore": hasMore})
}

func (a *App) sendMessage(w http.ResponseWriter, r *http.Request, u User) {
	channelID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný kanál")
		return
	}
	if _, member, _ := a.db.MemberRole(channelID, u.ID); !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	var in struct {
		Text         string  `json:"text"`
		AttachmentID *string `json:"attachmentId"`
		ReplyTo      *int64  `json:"replyTo"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	in.Text = strings.TrimSpace(in.Text)
	if len(in.Text) > 8000 {
		writeErr(w, http.StatusBadRequest, "Zpráva je moc dlouhá (max 8000 znaků)")
		return
	}
	if in.AttachmentID != nil {
		ok, err := a.db.AttachmentAvailable(*in.AttachmentID, u.ID)
		if err != nil || !ok {
			writeErr(w, http.StatusBadRequest, "Příloha není dostupná")
			return
		}
	}
	msg, err := a.db.CreateMessage(channelID, u.ID, in.Text, in.AttachmentID, nil, in.ReplyTo)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.hub.BroadcastChannel(channelID, map[string]any{"type": "message:new", "channelId": channelID, "message": msg})
	writeJSON(w, http.StatusOK, map[string]any{"message": msg})
}

func (a *App) deleteMessage(w http.ResponseWriter, r *http.Request, u User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatná zpráva")
		return
	}
	channelID, attachmentID, err := a.db.DeleteMessage(id, u.ID, u.Admin)
	if err != nil {
		writeErr(w, http.StatusForbidden, err.Error())
		return
	}
	if _, member, _ := a.db.MemberRole(channelID, u.ID); !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	if attachmentID != nil {
		a.removeAttachmentFile(*attachmentID)
	}
	a.hub.BroadcastChannel(channelID, map[string]any{"type": "message:deleted", "channelId": channelID, "messageId": id})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) react(w http.ResponseWriter, r *http.Request, u User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatná zpráva")
		return
	}
	var in struct {
		Emoji string `json:"emoji"`
	}
	if err := readJSON(r, &in); err != nil || strings.TrimSpace(in.Emoji) == "" || len([]rune(in.Emoji)) > 8 {
		writeErr(w, http.StatusBadRequest, "Neplatná reakce")
		return
	}
	channelID, reactions, err := a.db.ToggleReaction(id, u.ID, in.Emoji)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if _, member, _ := a.db.MemberRole(channelID, u.ID); !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	a.hub.BroadcastChannel(channelID, map[string]any{
		"type": "reaction:update", "channelId": channelID, "messageId": id, "reactions": reactions,
	})
	writeJSON(w, http.StatusOK, map[string]any{"reactions": reactions})
}

func (a *App) searchMessages(w http.ResponseWriter, r *http.Request, u User) {
	channelID, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný kanál")
		return
	}
	if _, member, _ := a.db.MemberRole(channelID, u.ID); !member {
		writeErr(w, http.StatusForbidden, "Do tohoto kanálu nemáš přístup")
		return
	}
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(q) < 2 {
		writeErr(w, http.StatusBadRequest, "Hledej alespoň 2 znaky")
		return
	}
	msgs, err := a.db.SearchMessages(channelID, q, u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Sprintf("Chyba hledání: %v", err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs})
}
