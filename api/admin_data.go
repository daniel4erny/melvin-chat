package main

import (
	"database/sql"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Read-only admin data browser: file index, table list and raw table rows.
// Session hashes and password hashes never leave the server.

var tableNameRe = regexp.MustCompile(`^[a-zA-Z0-9_]+$`)

var hiddenColumns = map[string]map[string]bool{
	"users":       {"password_hash": true},
	"sessions":    {"token_hash": true},
	"attachments": {},
}

type adminFile struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	Mime       string `json:"mime"`
	Kind       string `json:"kind"`
	Size       int64  `json:"size"`
	CreatedAt  int64  `json:"createdAt"`
	MessageID  int64  `json:"messageId"`
	UploaderID int64  `json:"uploaderId"`
	Uploader   string `json:"uploader"`
	Username   string `json:"username"`
	ChannelID  int64  `json:"channelId"`
	Channel    string `json:"channel"`
}

func (a *App) adminOverview(w http.ResponseWriter, r *http.Request, u User) {
	counts := map[string]int64{}
	for _, table := range []string{"users", "channels", "messages", "attachments", "uploads", "reactions", "polls", "sessions", "invites"} {
		var n int64
		if err := a.db.sql.QueryRow(fmt.Sprintf(`SELECT COUNT(*) FROM "%s"`, table)).Scan(&n); err == nil {
			counts[table] = n
		}
	}
	var dbBytes, fileBytes int64
	var pages, pageSize int64
	if err := a.db.sql.QueryRow("PRAGMA page_count").Scan(&pages); err == nil {
		if err := a.db.sql.QueryRow("PRAGMA page_size").Scan(&pageSize); err == nil {
			dbBytes = pages * pageSize
		}
	}
	_ = a.db.sql.QueryRow("SELECT COALESCE(SUM(size), 0) FROM attachments").Scan(&fileBytes)

	tables := []string{}
	rows, err := a.db.sql.Query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err == nil {
		for rows.Next() {
			var name string
			if rows.Scan(&name) == nil {
				tables = append(tables, name)
			}
		}
		rows.Close()
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"counts":    counts,
		"dbBytes":   dbBytes,
		"fileBytes": fileBytes,
		"tables":    tables,
	})
}

func (a *App) adminFiles(w http.ResponseWriter, r *http.Request, u User) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	limit := queryLimit(r, 50)
	offset := queryOffset(r)

	where := ""
	args := []any{}
	if q != "" {
		like := "%" + q + "%"
		where = ` WHERE (a.name LIKE ? OR u.display_name LIKE ? OR u.username LIKE ? OR c.name LIKE ?)`
		args = append(args, like, like, like, like)
	}

	var total int64
	countArgs := append([]any{}, args...)
	if err := a.db.sql.QueryRow(
		`SELECT COUNT(*) FROM attachments a
		 JOIN users u ON u.id = a.uploader_id
		 LEFT JOIN channels c ON c.id = a.channel_id`+where,
		countArgs...,
	).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "Soubory se nepodařilo načíst")
		return
	}

	rows, err := a.db.sql.Query(
		`SELECT a.id, a.name, a.mime, a.kind, a.size, a.created_at, COALESCE(a.message_id, 0),
		        u.id, u.display_name, u.username, COALESCE(c.id, 0), COALESCE(c.name, '')
		 FROM attachments a
		 JOIN users u ON u.id = a.uploader_id
		 LEFT JOIN channels c ON c.id = a.channel_id`+where+`
		 ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
		append(args, limit, offset)...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Soubory se nepodařilo načíst")
		return
	}
	defer rows.Close()

	files := []adminFile{}
	for rows.Next() {
		var f adminFile
		if err := rows.Scan(&f.ID, &f.Name, &f.Mime, &f.Kind, &f.Size, &f.CreatedAt, &f.MessageID,
			&f.UploaderID, &f.Uploader, &f.Username, &f.ChannelID, &f.Channel); err != nil {
			writeErr(w, http.StatusInternalServerError, "Soubory se nepodařilo načíst")
			return
		}
		files = append(files, f)
	}

	writeJSON(w, http.StatusOK, map[string]any{"files": files, "total": total})
}

func (a *App) adminTables(w http.ResponseWriter, r *http.Request, u User) {
	rows, err := a.db.sql.Query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Tabulky se nepodařilo načíst")
		return
	}
	defer rows.Close()

	out := []map[string]any{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			continue
		}
		var n int64
		_ = a.db.sql.QueryRow(fmt.Sprintf(`SELECT COUNT(*) FROM "%s"`, name)).Scan(&n)
		out = append(out, map[string]any{
			"name":    name,
			"rows":    n,
			"hidden":  hiddenFor(name),
			"visible": true,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"tables": out})
}

func (a *App) adminTableRows(w http.ResponseWriter, r *http.Request, u User) {
	name := r.PathValue("name")
	if !tableNameRe.MatchString(name) {
		writeErr(w, http.StatusBadRequest, "Neplatná tabulka")
		return
	}
	exists, err := a.tableExists(name)
	if err != nil || !exists {
		writeErr(w, http.StatusNotFound, "Tabulka neexistuje")
		return
	}

	columns, err := a.tableColumns(name)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Tabulku se nepodařilo načíst")
		return
	}

	hidden := hiddenFor(name)
	visible := make([]string, 0, len(columns))
	for _, col := range columns {
		if hidden[col] {
			continue
		}
		visible = append(visible, col)
	}
	if len(visible) == 0 {
		writeErr(w, http.StatusBadRequest, "Tabulka nemá čitelné sloupce")
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	where := ""
	args := []any{}
	if q != "" {
		like := "%" + q + "%"
		parts := make([]string, 0, len(visible))
		for _, col := range visible {
			parts = append(parts, fmt.Sprintf(`CAST("%s" AS TEXT) LIKE ?`, col))
			args = append(args, like)
		}
		where = " WHERE (" + strings.Join(parts, " OR ") + ")"
	}

	var total int64
	if err := a.db.sql.QueryRow(fmt.Sprintf(`SELECT COUNT(*) FROM "%s"%s`, name, where), args...).Scan(&total); err != nil {
		writeErr(w, http.StatusInternalServerError, "Tabulku se nepodařilo načíst")
		return
	}

	limit := queryLimit(r, 50)
	offset := queryOffset(r)

	selects := make([]string, len(visible))
	for i, col := range visible {
		selects[i] = fmt.Sprintf(`"%s"`, col)
	}
	rows, err := a.db.sql.Query(
		fmt.Sprintf(`SELECT %s FROM "%s"%s ORDER BY rowid DESC LIMIT ? OFFSET ?`,
			strings.Join(selects, ", "), name, where),
		append(args, limit, offset)...,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Tabulku se nepodařilo načíst")
		return
	}
	defer rows.Close()

	out := [][]any{}
	for rows.Next() {
		values := make([]any, len(visible))
		ptrs := make([]any, len(visible))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			writeErr(w, http.StatusInternalServerError, "Tabulku se nepodařilo načíst")
			return
		}
		for i, v := range values {
			if b, ok := v.([]byte); ok {
				values[i] = string(b)
			}
		}
		out = append(out, values)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"table": name, "columns": visible, "rows": out, "total": total,
	})
}

func hiddenFor(table string) map[string]bool {
	if cols, ok := hiddenColumns[table]; ok {
		return cols
	}
	return map[string]bool{}
}

func (a *App) tableExists(name string) (bool, error) {
	var found string
	err := a.db.sql.QueryRow(
		"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name,
	).Scan(&found)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (a *App) tableColumns(name string) ([]string, error) {
	rows, err := a.db.sql.Query(fmt.Sprintf(`PRAGMA table_info("%s")`, name))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	cols := []string{}
	for rows.Next() {
		var cid int
		var col, typ string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &col, &typ, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols = append(cols, col)
	}
	return cols, rows.Err()
}

func queryLimit(r *http.Request, fallback int) int {
	n, err := strconv.Atoi(r.URL.Query().Get("limit"))
	if err != nil || n <= 0 || n > 200 {
		return fallback
	}
	return n
}

func queryOffset(r *http.Request) int {
	n, err := strconv.Atoi(r.URL.Query().Get("offset"))
	if err != nil || n < 0 {
		return 0
	}
	return n
}
