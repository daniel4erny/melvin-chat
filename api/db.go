package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

var errNotFound = errors.New("not found")

type DB struct {
	sql *sql.DB
}

type UserSettings struct {
	Theme          string  `json:"theme"`          // dark | light | system
	Accent         string  `json:"accent"`         // hex color
	Density        string  `json:"density"`        // cozy | compact
	FontScale      float64 `json:"fontScale"`      // 0.85 - 1.3
	ShowErrors     bool    `json:"showErrors"`     // show error toasts / banner
	ShowTimestamps bool    `json:"showTimestamps"` // timestamps in messages
	EnterToSend    bool    `json:"enterToSend"`
	Notifications  bool    `json:"notifications"`
	Presence       string  `json:"presence"` // everyone | nobody
	MessageSound   bool    `json:"messageSound"`
	BubbleStyle    string  `json:"bubbleStyle"` // rounded | flat
}

func DefaultSettings() UserSettings {
	return UserSettings{
		Theme:          "dark",
		Accent:         "#5865f2",
		Density:        "cozy",
		FontScale:      1,
		ShowErrors:     true,
		ShowTimestamps: true,
		EnterToSend:    true,
		Notifications:  true,
		Presence:       "everyone",
		MessageSound:   true,
		BubbleStyle:    "rounded",
	}
}

type User struct {
	ID          int64        `json:"id"`
	Username    string       `json:"username"`
	DisplayName string       `json:"displayName"`
	AvatarColor string       `json:"avatarColor"`
	Bio         string       `json:"bio"`
	Admin       bool         `json:"admin"`
	StatusEmoji string       `json:"statusEmoji"`
	StatusText  string       `json:"statusText"`
	Banned      bool         `json:"banned"`
	BanReason   string       `json:"banReason"`
	BannedUntil *int64       `json:"bannedUntil,omitempty"`
	Settings    UserSettings `json:"settings"`
	CreatedAt   int64        `json:"createdAt"`
}

// BanActive reports whether the account is currently blocked from logging in.
// Expired bans are ignored so a timed ban never becomes permanent by accident.
func (u User) BanActive() bool {
	if !u.Banned {
		return false
	}
	return u.BannedUntil == nil || *u.BannedUntil > nowMS()
}

type Session struct {
	TokenHash string
	UserID    int64
	ExpiresAt int64
}

const schema = `
CREATE TABLE IF NOT EXISTS users (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
	display_name  TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	avatar_color  TEXT NOT NULL DEFAULT '#5865f2',
	bio           TEXT NOT NULL DEFAULT '',
	is_admin      INTEGER NOT NULL DEFAULT 0,
	status_emoji  TEXT NOT NULL DEFAULT '',
	status_text   TEXT NOT NULL DEFAULT '',
	banned        INTEGER NOT NULL DEFAULT 0,
	ban_reason    TEXT NOT NULL DEFAULT '',
	banned_until  INTEGER,
	banned_at     INTEGER,
	settings      TEXT NOT NULL DEFAULT '{}',
	created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	token_hash TEXT PRIMARY KEY,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS invites (
	code       TEXT PRIMARY KEY,
	created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	note       TEXT NOT NULL DEFAULT '',
	max_uses   INTEGER NOT NULL DEFAULT 1,
	uses       INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	expires_at INTEGER,
	revoked    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_invites_created ON invites(created_at);

CREATE TABLE IF NOT EXISTS channels (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	name       TEXT NOT NULL,
	topic      TEXT NOT NULL DEFAULT '',
	visibility TEXT NOT NULL DEFAULT 'public',
	owner_id   INTEGER NOT NULL REFERENCES users(id),
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS channel_members (
	channel_id   INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	role         TEXT NOT NULL DEFAULT 'member',
	joined_at    INTEGER NOT NULL,
	last_read_id INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON channel_members(user_id);

CREATE TABLE IF NOT EXISTS attachments (
	id          TEXT PRIMARY KEY,
	uploader_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	channel_id  INTEGER REFERENCES channels(id) ON DELETE CASCADE,
	message_id  INTEGER,
	name        TEXT NOT NULL,
	mime        TEXT NOT NULL,
	size        INTEGER NOT NULL,
	kind        TEXT NOT NULL DEFAULT 'file',
	duration    REAL NOT NULL DEFAULT 0,
	created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS uploads (
	id         TEXT PRIMARY KEY,
	user_id    INTEGER NOT NULL,
	name       TEXT NOT NULL,
	mime       TEXT NOT NULL,
	size       INTEGER NOT NULL,
	kind       TEXT NOT NULL DEFAULT 'file',
	duration   REAL NOT NULL DEFAULT 0,
	received   INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);

CREATE TABLE IF NOT EXISTS messages (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	channel_id    INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	text          TEXT NOT NULL DEFAULT '',
	attachment_id TEXT,
	poll_id       INTEGER,
	reply_to      INTEGER,
	created_at    INTEGER NOT NULL,
	edited_at     INTEGER,
	deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

CREATE TABLE IF NOT EXISTS reactions (
	message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	emoji      TEXT NOT NULL,
	PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS polls (
	id         INTEGER PRIMARY KEY AUTOINCREMENT,
	channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
	creator_id INTEGER NOT NULL REFERENCES users(id),
	question   TEXT NOT NULL,
	multi      INTEGER NOT NULL DEFAULT 0,
	anonymous  INTEGER NOT NULL DEFAULT 0,
	closed     INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_options (
	id       INTEGER PRIMARY KEY AUTOINCREMENT,
	poll_id  INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
	text     TEXT NOT NULL,
	position INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS poll_votes (
	poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
	option_id INTEGER NOT NULL REFERENCES poll_options(id) ON DELETE CASCADE,
	user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	PRIMARY KEY (poll_id, option_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(poll_id, user_id);
`

func openDB(path string) (*DB, error) {
	conn, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)")
	if err != nil {
		return nil, err
	}
	conn.SetMaxOpenConns(4)
	conn.SetMaxIdleConns(4)
	conn.SetConnMaxLifetime(time.Hour)

	if _, err := conn.Exec(schema); err != nil {
		conn.Close()
		return nil, err
	}
	if err := ensureColumns(conn, "users", map[string]string{
		"status_emoji": "TEXT NOT NULL DEFAULT ''",
		"status_text":  "TEXT NOT NULL DEFAULT ''",
		"banned":       "INTEGER NOT NULL DEFAULT 0",
		"ban_reason":   "TEXT NOT NULL DEFAULT ''",
		"banned_until": "INTEGER",
		"banned_at":    "INTEGER",
	}); err != nil {
		conn.Close()
		return nil, err
	}
	// Theme migration: the previous default accent was teal, the theme now uses
	// Discord blurple. Only rewrite the exact old default value.
	rows, err := conn.Query(`SELECT id, settings FROM users WHERE settings LIKE '%#5eead4%'`)
	if err != nil {
		conn.Close()
		return nil, err
	}
	type accentFix struct {
		id       int64
		settings UserSettings
	}
	var fixes []accentFix
	for rows.Next() {
		var id int64
		var raw string
		if err := rows.Scan(&id, &raw); err != nil {
			rows.Close()
			conn.Close()
			return nil, err
		}
		var s UserSettings
		if json.Unmarshal([]byte(raw), &s) != nil || s.Accent != "#5eead4" {
			continue
		}
		s.Accent = "#5865f2"
		fixes = append(fixes, accentFix{id: id, settings: s})
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		conn.Close()
		return nil, err
	}
	for _, fix := range fixes {
		raw, err := json.Marshal(fix.settings)
		if err != nil {
			conn.Close()
			return nil, err
		}
		if _, err := conn.Exec(`UPDATE users SET settings = ? WHERE id = ?`, string(raw), fix.id); err != nil {
			conn.Close()
			return nil, err
		}
	}
	return &DB{sql: conn}, nil
}

func nowMS() int64 { return time.Now().UnixMilli() }

func (d *DB) Close() error { return d.sql.Close() }

func decodeSettings(raw string) UserSettings {
	s := DefaultSettings()
	if raw != "" {
		_ = json.Unmarshal([]byte(raw), &s)
	}
	if s.Theme == "" {
		s.Theme = "dark"
	}
	if s.Presence == "" {
		s.Presence = "everyone"
	}
	if s.Accent == "" {
		s.Accent = "#5865f2"
	}
	if s.FontScale < 0.7 || s.FontScale > 1.5 {
		s.FontScale = 1
	}
	return s
}

const userCols = "u.id, u.username, u.display_name, u.avatar_color, u.bio, u.is_admin, u.status_emoji, u.status_text, u.banned, u.ban_reason, u.banned_until, u.settings, u.created_at"

// ensureColumns upgrades databases created by older versions in place.
func ensureColumns(conn *sql.DB, table string, cols map[string]string) error {
	rows, err := conn.Query("PRAGMA table_info(" + table + ")")
	if err != nil {
		return err
	}
	existing := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt any
		if err := rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk); err != nil {
			rows.Close()
			return err
		}
		existing[name] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for name, ddl := range cols {
		if existing[name] {
			continue
		}
		if _, err := conn.Exec("ALTER TABLE " + table + " ADD COLUMN " + name + " " + ddl); err != nil {
			return err
		}
	}
	return nil
}

type scanner interface {
	Scan(dest ...any) error
}

func scanUser(s scanner) (User, error) {
	var u User
	var admin, banned int
	var settings string
	var bannedUntil sql.NullInt64
	err := s.Scan(
		&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.Bio, &admin,
		&u.StatusEmoji, &u.StatusText, &banned, &u.BanReason, &bannedUntil,
		&settings, &u.CreatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, errNotFound
		}
		return User{}, err
	}
	u.Admin = admin != 0
	u.Banned = banned != 0
	if bannedUntil.Valid {
		v := bannedUntil.Int64
		u.BannedUntil = &v
	}
	u.Settings = decodeSettings(settings)
	return u, nil
}

func (d *DB) CountUsers() (int, error) {
	var n int
	err := d.sql.QueryRow("SELECT COUNT(*) FROM users").Scan(&n)
	return n, err
}

func (d *DB) CreateUser(username, displayName, passwordHash, avatarColor string) (User, error) {
	count, err := d.CountUsers()
	if err != nil {
		return User{}, err
	}
	admin := 0
	if count == 0 {
		admin = 1
	}
	settings, _ := json.Marshal(DefaultSettings())
	now := nowMS()
	res, err := d.sql.Exec(
		"INSERT INTO users (username, display_name, password_hash, avatar_color, is_admin, settings, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		username, displayName, passwordHash, avatarColor, admin, string(settings), now,
	)
	if err != nil {
		return User{}, err
	}
	id, _ := res.LastInsertId()
	// everyone belongs to every public channel
	if _, err := d.sql.Exec(
		"INSERT OR IGNORE INTO channel_members (channel_id, user_id, role, joined_at) SELECT id, ?, 'member', ? FROM channels WHERE visibility = 'public'",
		id, now,
	); err != nil {
		return User{}, err
	}
	return d.UserByID(id)
}

func (d *DB) UserByUsername(username string) (User, string, error) {
	var hash string
	row := d.sql.QueryRow("SELECT "+userCols+", u.password_hash FROM users u WHERE u.username = ?", username)
	return scanUserWithHash(row, &hash)
}

func scanUserWithHash(s scanner, hash *string) (User, string, error) {
	var u User
	var admin, banned int
	var settings string
	var bannedUntil sql.NullInt64
	err := s.Scan(
		&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.Bio, &admin,
		&u.StatusEmoji, &u.StatusText, &banned, &u.BanReason, &bannedUntil,
		&settings, &u.CreatedAt, hash,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, "", errNotFound
		}
		return User{}, "", err
	}
	u.Admin = admin != 0
	u.Banned = banned != 0
	if bannedUntil.Valid {
		v := bannedUntil.Int64
		u.BannedUntil = &v
	}
	u.Settings = decodeSettings(settings)
	return u, *hash, nil
}

func (d *DB) UserByID(id int64) (User, error) {
	return scanUser(d.sql.QueryRow("SELECT "+userCols+" FROM users u WHERE u.id = ?", id))
}

func (d *DB) ListUsers() ([]User, error) {
	rows, err := d.sql.Query("SELECT " + userCols + " FROM users u ORDER BY u.display_name COLLATE NOCASE")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, err
		}
		users = append(users, u)
	}
	return users, rows.Err()
}

func (d *DB) UpdateUserProfile(id int64, displayName, bio, avatarColor, statusEmoji, statusText *string, settings *UserSettings) (User, error) {
	u, err := d.UserByID(id)
	if err != nil {
		return User{}, err
	}
	if displayName != nil && strings.TrimSpace(*displayName) != "" {
		u.DisplayName = strings.TrimSpace(*displayName)
	}
	if bio != nil {
		u.Bio = strings.TrimSpace(*bio)
	}
	if avatarColor != nil && *avatarColor != "" {
		u.AvatarColor = *avatarColor
	}
	if statusEmoji != nil {
		u.StatusEmoji = strings.TrimSpace(*statusEmoji)
	}
	if statusText != nil {
		u.StatusText = strings.TrimSpace(*statusText)
	}
	if settings != nil {
		s := *settings
		if s.Theme == "" {
			s.Theme = "dark"
		}
		if s.Presence == "" {
			s.Presence = "everyone"
		}
		if s.Accent == "" {
			s.Accent = "#5865f2"
		}
		if s.FontScale < 0.7 || s.FontScale > 1.5 {
			s.FontScale = 1
		}
		u.Settings = s
	}
	raw, _ := json.Marshal(u.Settings)
	_, err = d.sql.Exec(
		"UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, status_emoji = ?, status_text = ?, settings = ? WHERE id = ?",
		u.DisplayName, u.Bio, u.AvatarColor, u.StatusEmoji, u.StatusText, string(raw), id,
	)
	if err != nil {
		return User{}, err
	}
	return d.UserByID(id)
}

func (d *DB) SetPassword(id int64, hash string) error {
	_, err := d.sql.Exec("UPDATE users SET password_hash = ? WHERE id = ?", hash, id)
	return err
}

func (d *DB) CreateSession(tokenHash string, userID int64, ttl time.Duration) error {
	now := nowMS()
	_, _ = d.sql.Exec("DELETE FROM sessions WHERE expires_at < ?", now)
	_, err := d.sql.Exec(
		"INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
		tokenHash, userID, now, now+ttl.Milliseconds(),
	)
	return err
}

func (d *DB) SessionUser(tokenHash string) (User, error) {
	u, err := scanUser(d.sql.QueryRow(
		"SELECT "+userCols+" FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
		tokenHash, nowMS(),
	))
	if err != nil {
		return User{}, err
	}
	return u, nil
}

func (d *DB) DeleteSession(tokenHash string) error {
	_, err := d.sql.Exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash)
	return err
}

func (d *DB) DeleteUserSessions(userID int64) error {
	_, err := d.sql.Exec("DELETE FROM sessions WHERE user_id = ?", userID)
	return err
}

func (d *DB) CountAdmins() (int, error) {
	var n int
	err := d.sql.QueryRow("SELECT COUNT(*) FROM users WHERE is_admin = 1").Scan(&n)
	return n, err
}

// SetAdmin flips the admin flag. Callers must check permissions first.
func (d *DB) SetAdmin(id int64, admin bool) (User, error) {
	flag := 0
	if admin {
		flag = 1
	}
	res, err := d.sql.Exec("UPDATE users SET is_admin = ? WHERE id = ?", flag, id)
	if err != nil {
		return User{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return User{}, errNotFound
	}
	return d.UserByID(id)
}

// BanUser blocks an account and records who did it and why. until is nil for a
// permanent ban; otherwise it is a unix timestamp in milliseconds.
func (d *DB) BanUser(id, bannedBy int64, reason string, until *int64) (User, error) {
	res, err := d.sql.Exec(
		"UPDATE users SET banned = 1, ban_reason = ?, banned_at = ?, banned_until = ? WHERE id = ?",
		strings.TrimSpace(reason), nowMS(), until, id,
	)
	if err != nil {
		return User{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return User{}, errNotFound
	}
	return d.UserByID(id)
}

func (d *DB) UnbanUser(id int64) (User, error) {
	res, err := d.sql.Exec(
		"UPDATE users SET banned = 0, ban_reason = '', banned_at = NULL, banned_until = NULL WHERE id = ?", id,
	)
	if err != nil {
		return User{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return User{}, errNotFound
	}
	return d.UserByID(id)
}

// ---- invites ----

type Invite struct {
	Code      string `json:"code"`
	CreatedBy int64  `json:"createdBy"`
	Note      string `json:"note"`
	MaxUses   int    `json:"maxUses"`
	Uses      int    `json:"uses"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt *int64 `json:"expiresAt,omitempty"`
	Revoked   bool   `json:"revoked"`
	Active    bool   `json:"active"`
}

const inviteCols = "code, created_by, note, max_uses, uses, created_at, expires_at, revoked"

func scanInvite(s scanner) (Invite, error) {
	var inv Invite
	var expires sql.NullInt64
	var revoked int
	if err := s.Scan(&inv.Code, &inv.CreatedBy, &inv.Note, &inv.MaxUses, &inv.Uses, &inv.CreatedAt, &expires, &revoked); err != nil {
		return Invite{}, err
	}
	if expires.Valid {
		v := expires.Int64
		inv.ExpiresAt = &v
	}
	inv.Revoked = revoked != 0
	inv.Active = !inv.Revoked && inv.Uses < inv.MaxUses && (inv.ExpiresAt == nil || *inv.ExpiresAt > nowMS())
	return inv, nil
}

func inviteCode() (string, error) {
	buf := make([]byte, 6)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func (d *DB) CreateInvite(createdBy int64, note string, maxUses int, expiresAt *int64) (Invite, error) {
	if maxUses < 1 {
		maxUses = 1
	}
	if maxUses > 100 {
		maxUses = 100
	}
	for attempt := 0; attempt < 5; attempt++ {
		code, err := inviteCode()
		if err != nil {
			return Invite{}, err
		}
		_, err = d.sql.Exec(
			"INSERT INTO invites (code, created_by, note, max_uses, uses, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
			code, createdBy, strings.TrimSpace(note), maxUses, nowMS(), expiresAt,
		)
		if err == nil {
			return d.InviteByCode(code)
		}
		if !strings.Contains(strings.ToLower(err.Error()), "unique") && !strings.Contains(strings.ToLower(err.Error()), "constraint") {
			return Invite{}, err
		}
	}
	return Invite{}, errors.New("nepodařilo se vygenerovat kód")
}

func (d *DB) InviteByCode(code string) (Invite, error) {
	inv, err := scanInvite(d.sql.QueryRow("SELECT "+inviteCols+" FROM invites WHERE code = ?", code))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Invite{}, errNotFound
		}
		return Invite{}, err
	}
	return inv, nil
}

func (d *DB) ListInvites() ([]Invite, error) {
	rows, err := d.sql.Query("SELECT " + inviteCols + " FROM invites ORDER BY created_at DESC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Invite{}
	for rows.Next() {
		inv, err := scanInvite(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, inv)
	}
	return out, rows.Err()
}

func (d *DB) ValidInviteCount() (int, error) {
	var n int
	err := d.sql.QueryRow(
		"SELECT COUNT(*) FROM invites WHERE revoked = 0 AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)",
		nowMS(),
	).Scan(&n)
	return n, err
}

func (d *DB) RevokeInvite(code string) error {
	res, err := d.sql.Exec("UPDATE invites SET revoked = 1 WHERE code = ?", code)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

// CheckInvite reports why an invite cannot be used, without consuming it.
func (d *DB) CheckInvite(code string) error {
	inv, err := d.InviteByCode(code)
	if err != nil {
		return errors.New("Pozvánka neexistuje")
	}
	if inv.Revoked {
		return errors.New("Pozvánka byla zrušena")
	}
	if inv.ExpiresAt != nil && *inv.ExpiresAt <= nowMS() {
		return errors.New("Pozvánka vypršela")
	}
	if inv.Uses >= inv.MaxUses {
		return errors.New("Pozvánka už byla použitá")
	}
	return nil
}

// ConsumeInvite atomically marks one use. Returns an error when the code is
// invalid, expired, revoked or already used up.
func (d *DB) ConsumeInvite(code string) error {
	res, err := d.sql.Exec(
		"UPDATE invites SET uses = uses + 1 WHERE code = ? AND revoked = 0 AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)",
		code, nowMS(),
	)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errors.New("Pozvánka je neplatná nebo už použitá")
	}
	return nil
}
