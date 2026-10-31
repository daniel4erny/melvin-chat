package main

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

const sessionTTL = 90 * 24 * time.Hour

var usernameRe = regexp.MustCompile(`^[a-zA-Z0-9_.-]{3,24}$`)
var colorRe = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func hashPassword(password string) (string, error) {
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	iter := 210_000
	key, err := pbkdf2.Key(sha256.New, password, salt, iter, 32)
	if err != nil {
		return "", err
	}
	return "pbkdf2$" + strconv.Itoa(iter) + "$" + hex.EncodeToString(salt) + "$" + hex.EncodeToString(key), nil
}

func verifyPassword(encoded, password string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 4 || parts[0] != "pbkdf2" {
		return false
	}
	iter, err := strconv.Atoi(parts[1])
	if err != nil || iter < 1000 || iter > 2_000_000 {
		return false
	}
	salt, err := hex.DecodeString(parts[2])
	if err != nil {
		return false
	}
	want, err := hex.DecodeString(parts[3])
	if err != nil || len(want) == 0 {
		return false
	}
	got, err := pbkdf2.Key(sha256.New, password, salt, iter, len(want))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

func randomToken() (token string, tokenHash string, err error) {
	buf := make([]byte, 32)
	if _, err = rand.Read(buf); err != nil {
		return "", "", err
	}
	token = hex.EncodeToString(buf)
	return token, hashToken(token), nil
}

func hashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func avatarFor(username string) string {
	colors := []string{"#5eead4", "#a78bfa", "#f472b6", "#fbbf24", "#60a5fa", "#fb7185", "#34d399", "#f97316"}
	sum := sha256.Sum256([]byte(strings.ToLower(username)))
	return colors[int(sum[0])%len(colors)]
}

func (a *App) tokenFromRequest(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if strings.HasPrefix(h, "Bearer ") {
		return strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	}
	if t := r.URL.Query().Get("token"); t != "" {
		return t
	}
	if c, err := r.Cookie("melvin_session"); err == nil {
		return c.Value
	}
	return ""
}

func (a *App) userFromRequest(r *http.Request) (User, string, error) {
	token := a.tokenFromRequest(r)
	if token == "" {
		return User{}, "", errNotFound
	}
	u, err := a.db.SessionUser(hashToken(token))
	if err != nil {
		return User{}, "", err
	}
	return u, token, nil
}

type authedHandler func(http.ResponseWriter, *http.Request, User)

func (a *App) auth(h authedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		u, _, err := a.userFromRequest(r)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "Nejsi přihlášený")
			return
		}
		h(w, r, u)
	}
}

func (a *App) admin(h authedHandler) http.HandlerFunc {
	return a.auth(func(w http.ResponseWriter, r *http.Request, u User) {
		if !u.Admin {
			writeErr(w, http.StatusForbidden, "Tohle může jen správce")
			return
		}
		h(w, r, u)
	})
}

func (a *App) issueSession(w http.ResponseWriter, u User) {
	token, tokenHash, err := randomToken()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba serveru")
		return
	}
	if err := a.db.CreateSession(tokenHash, u.ID, sessionTTL); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se vytvořit session")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "melvin_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "user": u})
}

type credentials struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	DisplayName string `json:"displayName"`
	Invite      string `json:"invite"`
}

func (a *App) register(w http.ResponseWriter, r *http.Request) {
	if !a.limiter.allow(clientIP(r), 8) {
		writeErr(w, http.StatusTooManyRequests, "Moc pokusů, zkus to za chvíli")
		return
	}
	var c credentials
	if err := readJSON(r, &c); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	c.Username = strings.TrimSpace(c.Username)
	c.DisplayName = strings.TrimSpace(c.DisplayName)
	if !usernameRe.MatchString(c.Username) {
		writeErr(w, http.StatusBadRequest, "Jméno musí mít 3–24 znaků (písmena, čísla, . _ -)")
		return
	}
	if len(c.Password) < 6 || len(c.Password) > 200 {
		writeErr(w, http.StatusBadRequest, "Heslo musí mít alespoň 6 znaků")
		return
	}

	count, err := a.db.CountUsers()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba serveru")
		return
	}
	firstUser := count == 0
	legacyCode := a.regCode != "" && subtle.ConstantTimeCompare([]byte(c.Invite), []byte(a.regCode)) == 1
	inviteCode := strings.TrimSpace(c.Invite)
	if !firstUser && !legacyCode {
		if inviteCode == "" {
			writeErr(w, http.StatusForbidden, "Registrace je jen na jednorázovou pozvánku")
			return
		}
		if err := a.db.CheckInvite(inviteCode); err != nil {
			writeErr(w, http.StatusForbidden, err.Error())
			return
		}
	}

	if c.DisplayName == "" {
		c.DisplayName = c.Username
	}
	hash, err := hashPassword(c.Password)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba serveru")
		return
	}
	u, err := a.db.CreateUser(c.Username, c.DisplayName, hash, avatarFor(c.Username))
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeErr(w, http.StatusConflict, "Toto jméno je už obsazené")
			return
		}
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se vytvořit účet")
		return
	}
	if !firstUser && !legacyCode {
		if err := a.db.ConsumeInvite(inviteCode); err != nil {
			log.Printf("invite %s consumed after user %d was created: %v", inviteCode, u.ID, err)
		}
	}
	if u.Admin {
		// First account on a fresh server gets a public home channel.
		if ch, err := a.db.CreateChannel("general", "Hlavní kanál – tady to začíná", "public", u.ID, nil); err == nil {
			a.notifyChannelsChanged(ch.ID)
		}
	}
	a.issueSession(w, u)
}

func (a *App) login(w http.ResponseWriter, r *http.Request) {
	if !a.limiter.allow(clientIP(r), 12) {
		writeErr(w, http.StatusTooManyRequests, "Moc pokusů, zkus to za chvíli")
		return
	}
	var c credentials
	if err := readJSON(r, &c); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	u, hash, err := a.db.UserByUsername(strings.TrimSpace(c.Username))
	if err != nil || !verifyPassword(hash, c.Password) {
		writeErr(w, http.StatusUnauthorized, "Špatné jméno nebo heslo")
		return
	}
	a.issueSession(w, u)
}

func (a *App) logout(w http.ResponseWriter, r *http.Request, _ User) {
	if t := a.tokenFromRequest(r); t != "" {
		_ = a.db.DeleteSession(hashToken(t))
	}
	http.SetCookie(w, &http.Cookie{Name: "melvin_session", Value: "", Path: "/", MaxAge: -1})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) me(w http.ResponseWriter, r *http.Request, u User) {
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

type profileUpdate struct {
	DisplayName *string       `json:"displayName"`
	Bio         *string       `json:"bio"`
	AvatarColor *string       `json:"avatarColor"`
	Settings    *UserSettings `json:"settings"`
}

func (a *App) updateMe(w http.ResponseWriter, r *http.Request, u User) {
	var p profileUpdate
	if err := readJSON(r, &p); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	if p.DisplayName != nil {
		n := strings.TrimSpace(*p.DisplayName)
		if len(n) < 1 || len(n) > 40 {
			writeErr(w, http.StatusBadRequest, "Zobrazované jméno musí mít 1–40 znaků")
			return
		}
	}
	if p.Bio != nil && len(strings.TrimSpace(*p.Bio)) > 300 {
		writeErr(w, http.StatusBadRequest, "Bio je moc dlouhé (max 300 znaků)")
		return
	}
	if p.AvatarColor != nil && !colorRe.MatchString(*p.AvatarColor) {
		writeErr(w, http.StatusBadRequest, "Neplatná barva")
		return
	}
	if p.Settings != nil {
		p.Settings = sanitizeSettings(p.Settings)
	}
	updated, err := a.db.UpdateUserProfile(u.ID, p.DisplayName, p.Bio, p.AvatarColor, p.Settings)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se uložit profil")
		return
	}
	a.hub.setPresence(u.ID, updated.Settings.Presence != "nobody")
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func sanitizeSettings(s *UserSettings) *UserSettings {
	out := *s
	switch out.Theme {
	case "dark", "light", "system":
	default:
		out.Theme = "dark"
	}
	switch out.Density {
	case "cozy", "compact":
	default:
		out.Density = "cozy"
	}
	switch out.Presence {
	case "everyone", "nobody":
	default:
		out.Presence = "everyone"
	}
	switch out.BubbleStyle {
	case "rounded", "flat":
	default:
		out.BubbleStyle = "rounded"
	}
	if !colorRe.MatchString(out.Accent) {
		out.Accent = "#5865f2"
	}
	if out.FontScale < 0.85 {
		out.FontScale = 0.85
	}
	if out.FontScale > 1.3 {
		out.FontScale = 1.3
	}
	return &out
}

func (a *App) changePassword(w http.ResponseWriter, r *http.Request, u User) {
	var body struct {
		Current string `json:"current"`
		New     string `json:"new"`
	}
	if err := readJSON(r, &body); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	_, hash, err := a.db.UserByUsername(u.Username)
	if err != nil || !verifyPassword(hash, body.Current) {
		writeErr(w, http.StatusForbidden, "Současné heslo nesedí")
		return
	}
	if len(body.New) < 6 || len(body.New) > 200 {
		writeErr(w, http.StatusBadRequest, "Nové heslo musí mít alespoň 6 znaků")
		return
	}
	newHash, err := hashPassword(body.New)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Chyba serveru")
		return
	}
	if err := a.db.SetPassword(u.ID, newHash); err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se změnit heslo")
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) listUsers(w http.ResponseWriter, r *http.Request, _ User) {
	users, err := a.db.ListUsers()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se načíst uživatele")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"users": users})
}

func (a *App) getUser(w http.ResponseWriter, r *http.Request, _ User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	u, err := a.db.UserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u})
}

// updateUserAdmin lets an admin grant or take away the admin flag.
func (a *App) updateUserAdmin(w http.ResponseWriter, r *http.Request, actor User) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný uživatel")
		return
	}
	var in struct {
		Admin *bool `json:"admin"`
	}
	if err := readJSON(r, &in); err != nil || in.Admin == nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	target, err := a.db.UserByID(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, "Uživatel neexistuje")
		return
	}
	if target.Admin && !*in.Admin {
		admins, err := a.db.CountAdmins()
		if err != nil {
			writeErr(w, http.StatusInternalServerError, "Chyba serveru")
			return
		}
		if admins <= 1 {
			writeErr(w, http.StatusBadRequest, "Musí zůstat alespoň jeden správce")
			return
		}
	}
	updated, err := a.db.SetAdmin(id, *in.Admin)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Nepodařilo se uložit práva")
		return
	}
	log.Printf("admin %d (%s) set admin=%v for user %d (%s)", actor.ID, actor.Username, *in.Admin, updated.ID, updated.Username)
	a.hub.broadcastAll(map[string]any{"type": "users:changed"})
	a.hub.BroadcastUsers([]int64{updated.ID}, map[string]any{"type": "user:updated", "user": updated})
	writeJSON(w, http.StatusOK, map[string]any{"user": updated})
}

func (a *App) config(w http.ResponseWriter, r *http.Request) {
	count, err := a.db.CountUsers()
	if err != nil {
		log.Printf("config: count users: %v", err)
	}
	invites, err := a.db.ValidInviteCount()
	if err != nil {
		log.Printf("config: count invites: %v", err)
	}
	needsInvite := count > 0
	registrationOpen := count == 0 || invites > 0 || a.regCode != ""
	writeJSON(w, http.StatusOK, map[string]any{
		"maxUploadMB":      a.maxUploadMB,
		"iceServers":       a.iceServers,
		"registrationOpen": registrationOpen,
		"needsInvite":      needsInvite,
		"version":          a.version,
	})
}

// tiny in-memory rate limiter, good enough for a friends server
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string][]int64
}

func newRateLimiter() *rateLimiter {
	return &rateLimiter{buckets: map[string][]int64{}}
}

func (l *rateLimiter) allow(key string, perMinute int) bool {
	now := time.Now().UnixMilli()
	cutoff := now - 60_000
	l.mu.Lock()
	defer l.mu.Unlock()
	list := l.buckets[key]
	kept := list[:0]
	for _, t := range list {
		if t > cutoff {
			kept = append(kept, t)
		}
	}
	if len(kept) >= perMinute {
		l.buckets[key] = kept
		return false
	}
	l.buckets[key] = append(kept, now)
	return true
}

var errBadInput = errors.New("bad input")
