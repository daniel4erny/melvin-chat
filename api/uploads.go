package main

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const uploadChunkSize = 4 * 1024 * 1024

func randomID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (a *App) uploadTempPath(id string) string {
	return filepath.Join(a.uploadDir, "tmp", id+".part")
}

func (a *App) uploadFilePath(id string) string {
	return filepath.Join(a.uploadDir, "files", id)
}

func (a *App) ensureUploadDirs() error {
	if err := os.MkdirAll(filepath.Join(a.uploadDir, "tmp"), 0o750); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(a.uploadDir, "avatars"), 0o750); err != nil {
		return err
	}
	return os.MkdirAll(filepath.Join(a.uploadDir, "files"), 0o750)
}

func (a *App) initUpload(w http.ResponseWriter, r *http.Request, u User) {
	if u.TimeoutActive() {
		timeoutBlocked(w)
		return
	}
	var in struct {
		Name     string  `json:"name"`
		Mime     string  `json:"mime"`
		Kind     string  `json:"kind"`
		Size     int64   `json:"size"`
		Duration float64 `json:"duration"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	name := strings.TrimSpace(filepath.Base(in.Name))
	if name == "" || name == "." || name == "/" {
		name = "soubor"
	}
	if len(name) > 180 {
		name = name[:180]
	}
	if in.Size <= 0 {
		writeErr(w, http.StatusBadRequest, "Prázdné soubory nejde nahrát")
		return
	}
	maxBytes := int64(a.maxUploadMB) * 1024 * 1024
	if in.Size > maxBytes {
		writeErr(w, http.StatusRequestEntityTooLarge, "Soubor je větší než limit "+strconv.Itoa(a.maxUploadMB)+" MB")
		return
	}
	kind := in.Kind
	switch kind {
	case "image", "video", "audio", "voice", "file":
	default:
		kind = kindFromMime(in.Mime)
	}
	mimeType := in.Mime
	if mimeType == "" || len(mimeType) > 120 {
		mimeType = "application/octet-stream"
	}
	if in.Duration < 0 || in.Duration > 60*60*24 {
		in.Duration = 0
	}
	id := randomID()
	_, err := a.db.sql.Exec(
		"INSERT INTO uploads (id, user_id, name, mime, size, kind, duration, received, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)",
		id, u.ID, name, mimeType, in.Size, kind, in.Duration, nowMS(),
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se zahájit nahrávání")
		return
	}
	f, err := os.OpenFile(a.uploadTempPath(id), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se vytvořit soubor")
		return
	}
	f.Close()
	writeJSON(w, http.StatusOK, map[string]any{
		"id": id, "chunkSize": uploadChunkSize, "maxSize": maxBytes,
	})
}

func kindFromMime(m string) string {
	switch {
	case strings.HasPrefix(m, "image/"):
		return "image"
	case strings.HasPrefix(m, "video/"):
		return "video"
	case strings.HasPrefix(m, "audio/"):
		return "audio"
	default:
		return "file"
	}
}

func (a *App) uploadStatus(w http.ResponseWriter, r *http.Request, u User) {
	var received, size int64
	err := a.db.sql.QueryRow("SELECT received, size FROM uploads WHERE id = ? AND user_id = ?",
		r.PathValue("id"), u.ID).Scan(&received, &size)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Nahrávání neexistuje")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": received, "size": size, "chunkSize": uploadChunkSize})
}

func (a *App) uploadChunk(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("id")
	var owner, size, received int64
	var kind string
	err := a.db.sql.QueryRow("SELECT user_id, size, received, kind FROM uploads WHERE id = ?", id).
		Scan(&owner, &size, &received, &kind)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Nahrávání neexistuje")
		return
	}
	if owner != u.ID {
		writeErr(w, http.StatusForbidden, "Tohle není tvoje nahrávání")
		return
	}
	offset, err := strconv.ParseInt(r.URL.Query().Get("offset"), 10, 64)
	if err != nil || offset != received {
		writeJSON(w, http.StatusConflict, map[string]any{"error": "Špatný offset", "received": received})
		return
	}
	limited := http.MaxBytesReader(w, r.Body, uploadChunkSize)
	data, err := io.ReadAll(limited)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Chunk je moc velký")
		return
	}
	if len(data) == 0 {
		writeErr(w, http.StatusBadRequest, "Prázdný chunk")
		return
	}
	if received+int64(len(data)) > size {
		writeErr(w, http.StatusBadRequest, "Data přesahují deklarovanou velikost")
		return
	}
	f, err := os.OpenFile(a.uploadTempPath(id), os.O_WRONLY|os.O_CREATE, 0o640)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba souboru")
		return
	}
	if err := f.Truncate(received); err != nil {
		f.Close()
		writeErr(w, http.StatusInternalServerError, "Chyba souboru")
		return
	}
	if _, err := f.Seek(received, io.SeekStart); err != nil {
		f.Close()
		writeErr(w, http.StatusInternalServerError, "Chyba souboru")
		return
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		writeErr(w, http.StatusInternalServerError, "Chyba zápisu")
		return
	}
	f.Close()
	received += int64(len(data))
	if _, err := a.db.sql.Exec("UPDATE uploads SET received = ? WHERE id = ?", received, id); err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba databáze")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"received": received, "size": size})
}

func (a *App) completeUpload(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("id")
	var owner, size, received int64
	var name, mimeType, kind string
	var duration float64
	err := a.db.sql.QueryRow(
		"SELECT user_id, size, received, name, mime, kind, duration FROM uploads WHERE id = ?", id,
	).Scan(&owner, &size, &received, &name, &mimeType, &kind, &duration)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Nahrávání neexistuje")
		return
	}
	if owner != u.ID {
		writeErr(w, http.StatusForbidden, "Tohle není tvoje nahrávání")
		return
	}
	if received != size {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"error": "Soubor není celý", "received": received, "size": size,
		})
		return
	}
	if err := os.Rename(a.uploadTempPath(id), a.uploadFilePath(id)); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se dokončit nahrávání")
		return
	}
	now := nowMS()
	tx, err := a.db.sql.Begin()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba databáze")
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		"INSERT INTO attachments (id, uploader_id, name, mime, size, kind, duration, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		id, u.ID, name, mimeType, size, kind, duration, now,
	); err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba databáze")
		return
	}
	if _, err := tx.Exec("DELETE FROM uploads WHERE id = ?", id); err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba databáze")
		return
	}
	if err := tx.Commit(); err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba databáze")
		return
	}
	att := Attachment{
		ID: id, UploaderID: u.ID, Name: name, Mime: mimeType,
		Size: size, Kind: kind, Duration: duration, CreatedAt: now,
	}
	writeJSON(w, http.StatusOK, map[string]any{"attachment": att})
}

func (a *App) serveFile(w http.ResponseWriter, r *http.Request, u User) {
	id := r.PathValue("id")
	var att Attachment
	var channelID sql.NullInt64
	err := a.db.sql.QueryRow(
		"SELECT id, uploader_id, channel_id, name, mime, size, kind, duration, created_at FROM attachments WHERE id = ?", id,
	).Scan(&att.ID, &att.UploaderID, &channelID, &att.Name, &att.Mime, &att.Size, &att.Kind, &att.Duration, &att.CreatedAt)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Soubor neexistuje")
		return
	}
	if !u.Admin {
		if channelID.Valid {
			if _, member, _ := a.db.MemberRole(channelID.Int64, u.ID); !member {
				writeErr(w, http.StatusForbidden, "K tomuto souboru nemáš přístup")
				return
			}
		} else if att.UploaderID != u.ID {
			writeErr(w, http.StatusForbidden, "K tomuto souboru nemáš přístup")
			return
		}
	}

	f, err := os.Open(a.uploadFilePath(id))
	if err != nil {
		writeErr(w, http.StatusNotFound, "Soubor chybí na disku")
		return
	}
	defer f.Close()
	contentType := att.Mime
	if contentType == "" || contentType == "application/octet-stream" {
		buf := make([]byte, 512)
		n, _ := f.Read(buf)
		contentType = http.DetectContentType(buf[:n])
		_, _ = f.Seek(0, io.SeekStart)
	}
	disposition := "attachment"
	if att.Kind == "image" || att.Kind == "video" || att.Kind == "audio" || att.Kind == "voice" {
		disposition = "inline"
	}
	cd := mime.FormatMediaType(disposition, map[string]string{"filename": att.Name})
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", cd)
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, att.Name, time.UnixMilli(att.CreatedAt), f)
}

func (a *App) removeAttachmentFile(id string) {
	_ = os.Remove(a.uploadFilePath(id))
}

// cleanupUploads removes abandoned partial uploads.
func (a *App) cleanupUploads() {
	cutoff := nowMS() - 24*60*60*1000
	rows, err := a.db.sql.Query("SELECT id FROM uploads WHERE created_at < ?", cutoff)
	if err != nil {
		return
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()
	for _, id := range ids {
		_ = os.Remove(a.uploadTempPath(id))
		_, _ = a.db.sql.Exec("DELETE FROM uploads WHERE id = ?", id)
	}
	entries, err := os.ReadDir(filepath.Join(a.uploadDir, "tmp"))
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.ModTime().Before(time.Now().Add(-24*time.Hour)) {
			_ = os.Remove(filepath.Join(a.uploadDir, "tmp", e.Name()))
		}
	}
}
