package main

import (
	"bytes"
	"database/sql"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const maxAvatarBytes = 8 << 20

func (a *App) avatarDir() string {
	return filepath.Join(a.uploadDir, "avatars")
}

func (a *App) avatarFilePath(id string) string {
	return filepath.Join(a.avatarDir(), id)
}

// uploadAvatar accepts a raw image body, validates it and stores it under a
// random id. The client crops the image to a square before sending it.
func (a *App) uploadAvatar(w http.ResponseWriter, r *http.Request, u User) {
	limited := http.MaxBytesReader(w, r.Body, maxAvatarBytes)
	data, err := io.ReadAll(limited)
	if err != nil {
		writeErr(w, http.StatusRequestEntityTooLarge, "Obrázek je moc velký (max 8 MB)")
		return
	}
	if len(data) < 32 {
		writeErr(w, http.StatusBadRequest, "Prázdný obrázek")
		return
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný obrázek – použij PNG, JPEG nebo GIF")
		return
	}
	if format != "jpeg" && format != "png" && format != "gif" {
		writeErr(w, http.StatusBadRequest, "Neplatný obrázek – použij PNG, JPEG nebo GIF")
		return
	}
	if cfg.Width < 16 || cfg.Height < 16 || cfg.Width > 4096 || cfg.Height > 4096 {
		writeErr(w, http.StatusBadRequest, "Obrázek musí mít 16–4096 px na každé straně")
		return
	}
	if err := os.MkdirAll(a.avatarDir(), 0o750); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se uložit obrázek")
		return
	}
	id := randomID()
	if err := os.WriteFile(a.avatarFilePath(id), data, 0o640); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se uložit obrázek")
		return
	}
	old := u.AvatarID
	updated, err := a.db.SetAvatarID(u.ID, id)
	if err != nil {
		_ = os.Remove(a.avatarFilePath(id))
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se uložit profil")
		return
	}
	if old != "" {
		_ = os.Remove(a.avatarFilePath(old))
	}
	a.hub.broadcastAll(map[string]any{"type": "user:updated", "user": updated})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (a *App) deleteAvatar(w http.ResponseWriter, r *http.Request, u User) {
	old := u.AvatarID
	updated, err := a.db.SetAvatarID(u.ID, "")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Profil se nepodařilo uložit")
		return
	}
	if old != "" {
		_ = os.Remove(a.avatarFilePath(old))
	}
	a.hub.broadcastAll(map[string]any{"type": "user:updated", "user": updated})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

// serveAvatar is public on purpose: <img> tags cannot send the bearer token.
// Files are keyed by an unguessable random id and contain only the avatar.
func (a *App) serveAvatar(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if len(id) != 32 || strings.Trim(id, "0123456789abcdef") != "" {
		writeErr(w, http.StatusNotFound, "Obrázek neexistuje")
		return
	}
	f, err := os.Open(a.avatarFilePath(id))
	if err != nil {
		writeErr(w, http.StatusNotFound, "Obrázek neexistuje")
		return
	}
	defer f.Close()
	head := make([]byte, 512)
	n, _ := f.Read(head)
	contentType := http.DetectContentType(head[:n])
	if !strings.HasPrefix(contentType, "image/") {
		writeErr(w, http.StatusNotFound, "Obrázek neexistuje")
		return
	}
	info, err := f.Stat()
	if err != nil {
		writeErr(w, http.StatusNotFound, "Obrázek neexistuje")
		return
	}
	_, _ = f.Seek(0, io.SeekStart)
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, id, info.ModTime().Truncate(time.Second), f)
}

func (a *App) userProfile(w http.ResponseWriter, r *http.Request, viewer User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	target, err := a.db.UserByID(id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errNotFound) {
			writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
			return
		}
		writeErr(w, http.StatusInternalServerError, "Uživatele se nepodařilo načíst")
		return
	}
	stats, err := a.db.UserStats(id, viewer.ID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Statistiky se nepodařilo načíst")
		return
	}
	online := a.hub.onlineSet()[id]
	if target.Settings.Presence == "nobody" && target.ID != viewer.ID {
		online = false
		target.LastSeen = 0
	}
	ips := []UserIP{}
	if viewer.Admin {
		ips, _ = a.db.ListUserIPs(id)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"user": target, "stats": stats, "online": online,
		"timeoutLeft": timeoutRemaining(target), "sharedChannels": stats.SharedChannels,
		"ips": ips,
	})
}

// userMessages powers "view messages" on a profile. It only walks channels the
// viewer is a member of, so private channels never leak into the list.
func (a *App) userMessages(w http.ResponseWriter, r *http.Request, viewer User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	if _, err := a.db.UserByID(id); err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	before, _ := strconv.ParseInt(r.URL.Query().Get("before"), 10, 64)
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	msgs, hasMore, err := a.db.UserMessages(id, viewer.ID, before, limit)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Zprávy se nepodařilo načíst")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"messages": msgs, "hasMore": hasMore})
}
