package main

import (
	"database/sql"
	"net/http"
	"strings"
	"unicode/utf8"
)

// Sticker is either a built-in emoji sticker (UserID 0) or a custom image
// sticker uploaded by one user. Image stickers reuse the regular upload
// pipeline with kind "sticker".
type Sticker struct {
	ID           string `json:"id"`
	UserID       int64  `json:"userId"`
	Name         string `json:"name"`
	Emoji        string `json:"emoji"`
	AttachmentID string `json:"attachmentId,omitempty"`
	Position     int    `json:"position"`
	CreatedAt    int64  `json:"createdAt"`
}

type builtinSticker struct {
	id    string
	name  string
	emoji string
}

// builtinStickers is the shared pack every account gets for free. Keeping the
// ids stable means old messages keep rendering even if the pack is reordered.
var builtinStickers = []builtinSticker{
	{"builtin-laugh", "Smích", "😂"},
	{"builtin-heart", "Srdce", "❤️"},
	{"builtin-fire", "Oheň", "🔥"},
	{"builtin-like", "Palec", "👍"},
	{"builtin-party", "Párty", "🎉"},
	{"builtin-skull", "Lebka", "💀"},
	{"builtin-cry", "Pláč", "😭"},
	{"builtin-love", "Láska", "😍"},
	{"builtin-cool", "Pohoda", "😎"},
	{"builtin-think", "Přemýšlení", "🤔"},
	{"builtin-eyes", "Oči", "👀"},
	{"builtin-celebrate", "Oslava", "🥳"},
	{"builtin-pray", "Díky", "🙏"},
	{"builtin-hundred", "Sto", "💯"},
	{"builtin-check", "Hotovo", "✅"},
	{"builtin-no", "Ne", "❌"},
	{"builtin-beer", "Pivo", "🍺"},
	{"builtin-coffee", "Káva", "☕"},
	{"builtin-rocket", "Raketa", "🚀"},
	{"builtin-taco", "Taco", "🌮"},
	{"builtin-dog", "Pejsek", "🐶"},
	{"builtin-cat", "Kočka", "🐱"},
	{"builtin-rainbow", "Duha", "🌈"},
	{"builtin-bolt", "Blesk", "⚡"},
	{"builtin-sleep", "Spánek", "😴"},
	{"builtin-mind", "Šok", "🤯"},
	{"builtin-heart-hands", "Srdíčka", "🫶"},
	{"builtin-pizza", "Pizza", "🍕"},
}

func seedBuiltinStickers(conn *sql.DB) error {
	tx, err := conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for i, item := range builtinStickers {
		if _, err := tx.Exec(
			`INSERT OR IGNORE INTO stickers (id, user_id, name, emoji, position, created_at)
			 VALUES (?, 0, ?, ?, ?, 0)`,
			item.id, item.name, item.emoji, i,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (d *DB) Stickers(userID int64) ([]Sticker, error) {
	rows, err := d.sql.Query(
		`SELECT id, user_id, name, emoji, COALESCE(attachment_id, ''), position, created_at
		 FROM stickers
		 WHERE (user_id = 0 OR user_id = ?) AND hidden = 0
		 ORDER BY CASE WHEN user_id = 0 THEN 0 ELSE 1 END, position, created_at DESC`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Sticker{}
	for rows.Next() {
		var s Sticker
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Emoji, &s.AttachmentID, &s.Position, &s.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// StickerForSend returns a sticker the user may post: either a built-in one or
// one from their own library.
func (d *DB) StickerForSend(id string, userID int64) (Sticker, error) {
	var s Sticker
	err := d.sql.QueryRow(
		`SELECT id, user_id, name, emoji, COALESCE(attachment_id, ''), position, created_at
		 FROM stickers WHERE id = ? AND (user_id = 0 OR user_id = ?) AND hidden = 0`,
		id, userID,
	).Scan(&s.ID, &s.UserID, &s.Name, &s.Emoji, &s.AttachmentID, &s.Position, &s.CreatedAt)
	if err != nil {
		return Sticker{}, errNotFound
	}
	return s, nil
}

func (d *DB) loadStickers(ids []string) (map[string]*Sticker, error) {
	out := map[string]*Sticker{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := d.sql.Query(
		`SELECT id, user_id, name, emoji, COALESCE(attachment_id, ''), position, created_at
		 FROM stickers WHERE id IN (`+placeholders(len(ids))+`)`,
		toAnyStrings(ids)...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var s Sticker
		if err := rows.Scan(&s.ID, &s.UserID, &s.Name, &s.Emoji, &s.AttachmentID, &s.Position, &s.CreatedAt); err != nil {
			return nil, err
		}
		cpy := s
		out[s.ID] = &cpy
	}
	return out, rows.Err()
}

func (d *DB) CreateSticker(userID int64, name, emoji, attachmentID string) (Sticker, error) {
	var maxPos int
	_ = d.sql.QueryRow("SELECT COALESCE(MAX(position), 0) FROM stickers WHERE user_id = ?", userID).Scan(&maxPos)
	s := Sticker{
		ID:           randomID(),
		UserID:       userID,
		Name:         strings.TrimSpace(name),
		Emoji:        strings.TrimSpace(emoji),
		AttachmentID: attachmentID,
		Position:     maxPos + 1,
		CreatedAt:    nowMS(),
	}
	var attachment any
	if attachmentID != "" {
		attachment = attachmentID
	}
	_, err := d.sql.Exec(
		`INSERT INTO stickers (id, user_id, name, emoji, attachment_id, position, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		s.ID, s.UserID, s.Name, s.Emoji, attachment, s.Position, s.CreatedAt,
	)
	if err != nil {
		return Sticker{}, err
	}
	return s, nil
}

// DeleteSticker hides a custom sticker from the user's library. Sent stickers
// stay visible in chat history, so the row is only flagged, never removed.
func (d *DB) DeleteSticker(id string, userID int64) error {
	res, err := d.sql.Exec("UPDATE stickers SET hidden = 1 WHERE id = ? AND user_id = ?", id, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

func (a *App) listStickers(w http.ResponseWriter, r *http.Request, u User) {
	stickers, err := a.db.Stickers(u.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Stikery se nepodařilo načíst")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"stickers": stickers})
}

func (a *App) createSticker(w http.ResponseWriter, r *http.Request, u User) {
	if u.TimeoutActive() {
		timeoutBlocked(w)
		return
	}
	var in struct {
		Name         string `json:"name"`
		Emoji        string `json:"emoji"`
		AttachmentID string `json:"attachmentId"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	in.Emoji = strings.TrimSpace(in.Emoji)
	in.Name = strings.TrimSpace(in.Name)
	if len([]rune(in.Name)) > 40 {
		writeErr(w, http.StatusBadRequest, "Název stikeru je moc dlouhý (max 40 znaků)")
		return
	}
	if in.Emoji != "" && in.AttachmentID != "" {
		writeErr(w, http.StatusBadRequest, "Stiker může být buď emoji, nebo obrázek")
		return
	}
	if in.Emoji == "" && in.AttachmentID == "" {
		writeErr(w, http.StatusBadRequest, "Chybí emoji nebo obrázek")
		return
	}
	if in.Emoji != "" && utf8.RuneCountInString(in.Emoji) > 16 {
		writeErr(w, http.StatusBadRequest, "Emoji stiker je moc dlouhý")
		return
	}
	if in.Name == "" {
		in.Name = in.Emoji
	}
	if in.AttachmentID != "" {
		var owner int64
		var kind string
		var messageID sql.NullInt64
		err := a.db.sql.QueryRow(
			"SELECT uploader_id, kind, message_id FROM attachments WHERE id = ?", in.AttachmentID,
		).Scan(&owner, &kind, &messageID)
		if err != nil || owner != u.ID || kind != "sticker" || messageID.Valid {
			writeErr(w, http.StatusBadRequest, "Obrázek stikeru není dostupný")
			return
		}
	}
	sticker, err := a.db.CreateSticker(u.ID, in.Name, in.Emoji, in.AttachmentID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Stiker se nepodařilo uložit")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sticker": sticker})
}

func (a *App) deleteSticker(w http.ResponseWriter, r *http.Request, u User) {
	if err := a.db.DeleteSticker(r.PathValue("id"), u.ID); err != nil {
		writeErr(w, http.StatusNotFound, "Stiker neexistuje")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
