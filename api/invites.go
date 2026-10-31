package main

import (
	"log"
	"net/http"
	"strings"
)

// Admin-only invite management. Registration itself lives in auth.go.
func (a *App) listInvites(w http.ResponseWriter, r *http.Request, _ User) {
	invites, err := a.db.ListInvites()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Pozvánky se nepodařilo načíst")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invites": invites})
}

func (a *App) createInvite(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Note           string `json:"note"`
		MaxUses        int    `json:"maxUses"`
		ExpiresInHours int    `json:"expiresInHours"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	if in.MaxUses < 1 {
		in.MaxUses = 1
	}
	if in.MaxUses > 100 {
		in.MaxUses = 100
	}
	var expiresAt *int64
	if in.ExpiresInHours > 0 {
		if in.ExpiresInHours > 24*365 {
			in.ExpiresInHours = 24 * 365
		}
		t := nowMS() + int64(in.ExpiresInHours)*60*60*1000
		expiresAt = &t
	}
	inv, err := a.db.CreateInvite(u.ID, strings.TrimSpace(in.Note), in.MaxUses, expiresAt)
	if err != nil {
		log.Printf("create invite: %v", err)
		writeErr(w, http.StatusInternalServerError, "Pozvánku se nepodařilo vytvořit")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"invite": inv})
}

func (a *App) revokeInvite(w http.ResponseWriter, r *http.Request, _ User) {
	code := strings.TrimSpace(r.PathValue("code"))
	if code == "" {
		writeErr(w, http.StatusBadRequest, "Chybí kód pozvánky")
		return
	}
	if err := a.db.RevokeInvite(code); err != nil {
		writeErr(w, http.StatusNotFound, "Pozvánka neexistuje")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// Public check used by the login page to show a friendly hint before signup.
func (a *App) checkInvite(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.PathValue("code"))
	if code == "" {
		writeJSON(w, http.StatusOK, map[string]any{"valid": false, "reason": "Chybí kód pozvánky"})
		return
	}
	if err := a.db.CheckInvite(code); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"valid": false, "reason": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"valid": true})
}
