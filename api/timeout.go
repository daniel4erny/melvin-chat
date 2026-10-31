package main

import (
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxTimeoutMinutes = 28 * 24 * 60 // 28 days, same ceiling Discord uses

// timeoutBlocked writes the shared Czech "you are timed out" error. Every
// write path goes through it so the message stays consistent.
func timeoutBlocked(w http.ResponseWriter) {
	writeErr(w, http.StatusForbidden, "Máš timeout – dočasně nemůžeš psát ani reagovat.")
}

// timeoutUser mutes an account for a while. Unlike a ban it keeps the session
// alive: the user can still read, they just cannot write or join calls.
func (a *App) timeoutUser(w http.ResponseWriter, r *http.Request, actor User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	if id == actor.ID {
		writeErr(w, http.StatusBadRequest, "Sám sobě timeout dát nemůžeš")
		return
	}
	target, err := a.db.UserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	if target.Admin {
		writeErr(w, http.StatusBadRequest, "Adminovi nejde dát timeout. Nejdřív mu odeber práva.")
		return
	}
	var in struct {
		Minutes int    `json:"minutes"`
		Reason  string `json:"reason"`
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
	if in.Minutes < 1 {
		in.Minutes = 1
	}
	if in.Minutes > maxTimeoutMinutes {
		in.Minutes = maxTimeoutMinutes
	}
	until := nowMS() + int64(in.Minutes)*60*1000
	updated, err := a.db.SetTimeout(id, &until, in.Reason)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Timeout se nepodařilo nastavit")
		return
	}
	log.Printf("admin %d (%s) timed out user %d (%s) for %d min reason=%q",
		actor.ID, actor.Username, updated.ID, updated.Username, in.Minutes, in.Reason)
	a.hub.BroadcastUsers([]int64{id}, map[string]any{
		"type": "user:timeout", "userId": id, "until": until, "reason": in.Reason,
	})
	a.hub.broadcastAll(map[string]any{"type": "user:updated", "user": updated})
	a.hub.broadcastAll(map[string]any{"type": "users:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (a *App) clearTimeout(w http.ResponseWriter, r *http.Request, actor User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	updated, err := a.db.SetTimeout(id, nil, "")
	if err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	log.Printf("admin %d (%s) cleared timeout of user %d (%s)", actor.ID, actor.Username, updated.ID, updated.Username)
	a.hub.broadcastAll(map[string]any{"type": "user:updated", "user": updated})
	a.hub.broadcastAll(map[string]any{"type": "users:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

// timeoutRemaining is used by the profile payload so the client does not have
// to do date math against a clock that might be off.
func timeoutRemaining(u User) int64 {
	if !u.TimeoutActive() {
		return 0
	}
	left := *u.TimeoutUntil - nowMS()
	if left < 0 {
		return 0
	}
	return left
}

func formatTimeoutLeft(ms int64) string {
	d := time.Duration(ms) * time.Millisecond
	if d >= time.Hour {
		return strconv.Itoa(int(d.Hours()+0.5)) + " h"
	}
	return strconv.Itoa(int(d.Minutes()+0.5)) + " min"
}
