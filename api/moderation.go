package main

import (
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// banUser lets an admin block an account. The target loses every session and
// cannot log in until the ban is lifted or its timer runs out.
func (a *App) banUser(w http.ResponseWriter, r *http.Request, actor User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	if id == actor.ID {
		writeErr(w, http.StatusBadRequest, "Sám sebe zabanovat nemůžeš")
		return
	}
	target, err := a.db.UserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	if target.Admin {
		writeErr(w, http.StatusBadRequest, "Admina nejde zabanovat. Nejdřív mu odeber práva.")
		return
	}
	var in struct {
		Reason string `json:"reason"`
		Hours  int    `json:"hours"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	in.Reason = strings.TrimSpace(in.Reason)
	if len([]rune(in.Reason)) > 200 {
		writeErr(w, http.StatusBadRequest, "Důvod je moc dlouhý (max 200 znaků)")
		return
	}
	if in.Hours < 0 {
		in.Hours = 0
	}
	if in.Hours > 24*365 {
		in.Hours = 24 * 365
	}
	var until *int64
	if in.Hours > 0 {
		t := nowMS() + int64(in.Hours)*60*60*1000
		until = &t
	}
	updated, err := a.db.BanUser(id, actor.ID, in.Reason, until)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Uživatele se nepodařilo zabanovat")
		return
	}
	if err := a.db.DeleteUserSessions(id); err != nil {
		log.Printf("ban %d: delete sessions: %v", id, err)
	}
	log.Printf("admin %d (%s) banned user %d (%s) until=%v reason=%q", actor.ID, actor.Username, updated.ID, updated.Username, until, in.Reason)
	a.hub.BroadcastUsers([]int64{id}, map[string]any{
		"type": "user:banned", "reason": updated.BanReason, "bannedUntil": updated.BannedUntil,
	})
	go func() {
		time.Sleep(250 * time.Millisecond)
		a.hub.DisconnectUser(id)
	}()
	a.hub.broadcastAll(map[string]any{"type": "user:updated", "user": updated})
	a.hub.broadcastAll(map[string]any{"type": "users:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (a *App) unbanUser(w http.ResponseWriter, r *http.Request, actor User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	updated, err := a.db.UnbanUser(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	log.Printf("admin %d (%s) unbanned user %d (%s)", actor.ID, actor.Username, updated.ID, updated.Username)
	a.hub.broadcastAll(map[string]any{"type": "user:updated", "user": updated})
	a.hub.broadcastAll(map[string]any{"type": "users:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}
