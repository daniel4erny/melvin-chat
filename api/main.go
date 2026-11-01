package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const versionDefault = "0.1.0"

type App struct {
	db          *DB
	hub         *Hub
	uploadDir   string
	maxUploadMB int
	regCode     string
	iceServers  []string
	version     string
	limiter     *rateLimiter
}

func main() {
	port := env("PORT", "8000")
	dbPath := env("DB_PATH", "/data/melvin.db")
	uploadDir := env("UPLOAD_DIR", "/data/uploads")
	maxUploadMB, _ := strconv.Atoi(env("MAX_UPLOAD_MB", "500"))
	if maxUploadMB < 1 {
		maxUploadMB = 500
	}
	regCode := os.Getenv("REGISTRATION_CODE")
	version := env("VERSION", versionDefault)

	iceServers := []string{}
	for _, s := range strings.Split(env("ICE_SERVERS", "stun:stun.l.google.com:19302"), ",") {
		if s = strings.TrimSpace(s); s != "" {
			iceServers = append(iceServers, s)
		}
	}

	if dir := filepath.Dir(dbPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			log.Fatalf("db dir: %v", err)
		}
	}
	store, err := openDB(dbPath)
	if err != nil {
		log.Fatalf("db: %v", err)
	}
	defer store.Close()

	app := &App{
		db:          store,
		uploadDir:   uploadDir,
		maxUploadMB: maxUploadMB,
		regCode:     regCode,
		iceServers:  iceServers,
		version:     version,
		limiter:     newRateLimiter(),
	}
	if err := app.ensureUploadDirs(); err != nil {
		log.Fatalf("uploads: %v", err)
	}
	app.hub = newHub(store)

	go func() {
		app.cleanupUploads()
		t := time.NewTicker(time.Hour)
		defer t.Stop()
		for range t.C {
			app.cleanupUploads()
		}
	}()

	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", app.health)
	mux.HandleFunc("GET /api/health", app.health)
	mux.HandleFunc("GET /api/config", app.config)

	mux.HandleFunc("POST /api/auth/register", app.register)
	mux.HandleFunc("POST /api/auth/login", app.login)
	mux.HandleFunc("POST /api/auth/logout", app.auth(app.logout))
	mux.HandleFunc("GET /api/auth/me", app.auth(app.me))

	mux.HandleFunc("PATCH /api/me", app.auth(app.updateMe))
	mux.HandleFunc("POST /api/me/password", app.auth(app.changePassword))
	mux.HandleFunc("POST /api/me/avatar", app.auth(app.uploadAvatar))
	mux.HandleFunc("DELETE /api/me/avatar", app.auth(app.deleteAvatar))
	mux.HandleFunc("GET /api/avatars/{id}", app.serveAvatar)
	mux.HandleFunc("GET /api/users", app.auth(app.listUsers))
	mux.HandleFunc("GET /api/users/{id}", app.auth(app.getUser))
	mux.HandleFunc("GET /api/users/{id}/profile", app.auth(app.userProfile))
	mux.HandleFunc("GET /api/users/{id}/messages", app.auth(app.userMessages))
	mux.HandleFunc("PATCH /api/users/{id}", app.admin(app.updateUserAdmin))
	mux.HandleFunc("POST /api/users/{id}/ban", app.admin(app.banUser))
	mux.HandleFunc("POST /api/users/{id}/unban", app.admin(app.unbanUser))
	mux.HandleFunc("POST /api/users/{id}/timeout", app.admin(app.timeoutUser))
	mux.HandleFunc("DELETE /api/users/{id}/timeout", app.admin(app.clearTimeout))

	mux.HandleFunc("GET /api/invites", app.admin(app.listInvites))
	mux.HandleFunc("POST /api/invites", app.admin(app.createInvite))
	mux.HandleFunc("GET /api/invites/{code}", app.checkInvite)
	mux.HandleFunc("DELETE /api/invites/{code}", app.admin(app.revokeInvite))

	mux.HandleFunc("GET /api/admin/overview", app.admin(app.adminOverview))
	mux.HandleFunc("GET /api/admin/files", app.admin(app.adminFiles))
	mux.HandleFunc("GET /api/admin/tables", app.admin(app.adminTables))
	mux.HandleFunc("GET /api/admin/table/{name}", app.admin(app.adminTableRows))

	mux.HandleFunc("POST /api/dms", app.auth(app.createDM))
	mux.HandleFunc("GET /api/channels", app.auth(app.listChannels))
	mux.HandleFunc("POST /api/channels", app.auth(app.createChannel))
	mux.HandleFunc("GET /api/channels/{id}", app.auth(app.getChannel))
	mux.HandleFunc("PATCH /api/channels/{id}", app.auth(app.updateChannel))
	mux.HandleFunc("DELETE /api/channels/{id}", app.auth(app.deleteChannel))
	mux.HandleFunc("POST /api/channels/{id}/leave", app.auth(app.leaveChannel))
	mux.HandleFunc("POST /api/channels/{id}/read", app.auth(app.markRead))
	mux.HandleFunc("GET /api/channels/{id}/messages", app.auth(app.listMessages))
	mux.HandleFunc("POST /api/channels/{id}/messages", app.auth(app.sendMessage))
	mux.HandleFunc("GET /api/channels/{id}/search", app.auth(app.searchMessages))
	mux.HandleFunc("GET /api/channels/{id}/pins", app.auth(app.listPinnedMessages))
	mux.HandleFunc("POST /api/channels/{id}/polls", app.auth(app.createPoll))

	mux.HandleFunc("DELETE /api/messages/{id}", app.auth(app.deleteMessage))
	mux.HandleFunc("PATCH /api/messages/{id}", app.auth(app.updateMessage))
	mux.HandleFunc("POST /api/messages/{id}/pin", app.auth(app.pinMessage))
	mux.HandleFunc("DELETE /api/messages/{id}/pin", app.auth(app.unpinMessage))
	mux.HandleFunc("POST /api/messages/{id}/reactions", app.auth(app.react))

	mux.HandleFunc("POST /api/polls/{id}/vote", app.auth(app.votePoll))
	mux.HandleFunc("POST /api/polls/{id}/close", app.auth(app.closePoll))

	mux.HandleFunc("POST /api/uploads/init", app.auth(app.initUpload))
	mux.HandleFunc("GET /api/uploads/{id}", app.auth(app.uploadStatus))
	mux.HandleFunc("PUT /api/uploads/{id}/chunk", app.auth(app.uploadChunk))
	mux.HandleFunc("POST /api/uploads/{id}/complete", app.auth(app.completeUpload))

	mux.HandleFunc("GET /api/files/{id}", app.auth(app.serveFile))
	mux.HandleFunc("/ws", app.hub.ServeWS)

	handler := securityHeaders(cors(recoverer(logRequests(mux))))

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 15 * time.Second,
		// no WriteTimeout: uploads/downloads may legitimately take a long time
	}

	go func() {
		log.Printf("Melvin API %s listening on :%s (uploads dir %s, max %d MB)", version, port, uploadDir, maxUploadMB)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	store.Close()
	log.Println("bye")
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func (a *App) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "version": a.version})
}

// ---- http helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]any{"error": msg})
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(io.LimitReader(r.Body, 1<<20))
	if err := dec.Decode(dst); err != nil {
		return err
	}
	return nil
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// The rightmost entry is the address added by the closest proxy. Using
		// the leftmost value would trust anything the client sent itself.
		parts := strings.Split(xff, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			if ip := strings.TrimSpace(parts[i]); ip != "" {
				return ip
			}
		}
	}
	if xr := r.Header.Get("X-Real-IP"); xr != "" {
		return strings.TrimSpace(xr)
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// ---- middleware ----

type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap lets http.NewResponseController reach the real writer.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// Hijack is required by the WebSocket upgrader; without it /ws would 500.
func (s *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h, ok := s.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("hijacking not supported")
	}
	return h.Hijack()
}

func (s *statusRecorder) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Printf("%s %s %d %s", r.Method, r.URL.Path, rec.status, time.Since(start).Round(time.Millisecond))
	})
}

func recoverer(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				log.Printf("panic on %s %s: %v", r.Method, r.URL.Path, rec)
				writeErr(w, http.StatusInternalServerError, "Interní chyba serveru")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Range")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, HEAD, OPTIONS")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges, Content-Disposition")
		w.Header().Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}
