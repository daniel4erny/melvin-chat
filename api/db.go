package main

import (
	"database/sql"
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
		Accent:         "#5eead4",
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
	Settings    UserSettings `json:"settings"`
	CreatedAt   int64        `json:"createdAt"`
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
	avatar_color  TEXT NOT NULL DEFAULT '#5eead4',
	bio           TEXT NOT NULL DEFAULT '',
	is_admin      INTEGER NOT NULL DEFAULT 0,
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
		s.Accent = "#5eead4"
	}
	if s.FontScale < 0.7 || s.FontScale > 1.5 {
		s.FontScale = 1
	}
	return s
}

const userCols = "u.id, u.username, u.display_name, u.avatar_color, u.bio, u.is_admin, u.settings, u.created_at"

type scanner interface {
	Scan(dest ...any) error
}

func scanUser(s scanner) (User, error) {
	var u User
	var admin int
	var settings string
	err := s.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.Bio, &admin, &settings, &u.CreatedAt)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, errNotFound
		}
		return User{}, err
	}
	u.Admin = admin != 0
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
	var u User
	var admin int
	var settings string
	err := row.Scan(&u.ID, &u.Username, &u.DisplayName, &u.AvatarColor, &u.Bio, &admin, &settings, &u.CreatedAt, &hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return User{}, "", errNotFound
		}
		return User{}, "", err
	}
	u.Admin = admin != 0
	u.Settings = decodeSettings(settings)
	return u, hash, nil
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

func (d *DB) UpdateUserProfile(id int64, displayName, bio, avatarColor *string, settings *UserSettings) (User, error) {
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
	if settings != nil {
		s := *settings
		if s.Theme == "" {
			s.Theme = "dark"
		}
		if s.Presence == "" {
			s.Presence = "everyone"
		}
		if s.Accent == "" {
			s.Accent = "#5eead4"
		}
		if s.FontScale < 0.7 || s.FontScale > 1.5 {
			s.FontScale = 1
		}
		u.Settings = s
	}
	raw, _ := json.Marshal(u.Settings)
	_, err = d.sql.Exec(
		"UPDATE users SET display_name = ?, bio = ?, avatar_color = ?, settings = ? WHERE id = ?",
		u.DisplayName, u.Bio, u.AvatarColor, string(raw), id,
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
