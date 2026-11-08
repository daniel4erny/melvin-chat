package main

import (
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Permission bits are additive, so a member can hold several roles at once.
const (
	PermManageChannels = 1 << iota
	PermManageMessages
	PermManageMembers
	PermAll = PermManageChannels | PermManageMessages | PermManageMembers
)

type Role struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Color       string `json:"color"`
	Position    int    `json:"position"`
	Permissions int    `json:"permissions"`
	CreatedAt   int64  `json:"createdAt"`
}

var roleColorPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

func validRoleName(name string) bool {
	n := utf8.RuneCountInString(name)
	return n >= 1 && n <= 32
}

func validPermissions(perms int) bool {
	return perms >= 0 && perms&^PermAll == 0
}

const roleCols = "id, name, color, position, permissions, created_at"

func scanRole(s scanner) (Role, error) {
	var r Role
	if err := s.Scan(&r.ID, &r.Name, &r.Color, &r.Position, &r.Permissions, &r.CreatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return Role{}, errNotFound
		}
		return Role{}, err
	}
	return r, nil
}

func (d *DB) RoleByID(id int64) (Role, error) {
	return scanRole(d.sql.QueryRow("SELECT "+roleCols+" FROM roles WHERE id = ?", id))
}

func (d *DB) ListRoles() ([]Role, error) {
	rows, err := d.sql.Query("SELECT " + roleCols + " FROM roles ORDER BY position DESC, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	roles := []Role{}
	for rows.Next() {
		r, err := scanRole(rows)
		if err != nil {
			return nil, err
		}
		roles = append(roles, r)
	}
	return roles, rows.Err()
}

func (d *DB) CreateRole(name, color string, permissions int) (Role, error) {
	var position int
	if err := d.sql.QueryRow("SELECT COALESCE(MAX(position), 0) + 1 FROM roles").Scan(&position); err != nil {
		return Role{}, err
	}
	res, err := d.sql.Exec(
		"INSERT INTO roles (name, color, position, permissions, created_at) VALUES (?, ?, ?, ?, ?)",
		name, color, position, permissions, nowMS(),
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return Role{}, errors.New("role s tímto názvem už existuje")
		}
		return Role{}, err
	}
	id, _ := res.LastInsertId()
	return d.RoleByID(id)
}

func (d *DB) UpdateRole(id int64, name, color *string, permissions *int) (Role, error) {
	role, err := d.RoleByID(id)
	if err != nil {
		return Role{}, err
	}
	if name != nil {
		role.Name = *name
	}
	if color != nil {
		role.Color = *color
	}
	if permissions != nil {
		role.Permissions = *permissions
	}
	res, err := d.sql.Exec(
		"UPDATE roles SET name = ?, color = ?, permissions = ? WHERE id = ?",
		role.Name, role.Color, role.Permissions, id,
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return Role{}, errors.New("role s tímto názvem už existuje")
		}
		return Role{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Role{}, errNotFound
	}
	return d.RoleByID(id)
}

func (d *DB) DeleteRole(id int64) error {
	res, err := d.sql.Exec("DELETE FROM roles WHERE id = ?", id)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return errNotFound
	}
	return nil
}

func (d *DB) UserRoleIDs(userID int64) ([]int64, error) {
	rows, err := d.sql.Query("SELECT role_id FROM user_roles WHERE user_id = ?", userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (d *DB) SetUserRoles(userID int64, roleIDs []int64) (User, error) {
	if _, err := d.UserByID(userID); err != nil {
		return User{}, errNotFound
	}
	tx, err := d.sql.Begin()
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM user_roles WHERE user_id = ?", userID); err != nil {
		return User{}, err
	}
	seen := map[int64]bool{}
	for _, roleID := range roleIDs {
		if roleID <= 0 || seen[roleID] {
			continue
		}
		var exists int
		if err := tx.QueryRow("SELECT 1 FROM roles WHERE id = ?", roleID).Scan(&exists); err != nil {
			return User{}, errors.New("role neexistuje")
		}
		seen[roleID] = true
		if _, err := tx.Exec("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", userID, roleID); err != nil {
			return User{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return d.userWithRoles(userID)
}

func (d *DB) userWithRoles(userID int64) (User, error) {
	u, err := d.UserByID(userID)
	if err != nil {
		return User{}, err
	}
	users := []User{u}
	if err := d.hydrateUsers(users); err != nil {
		return User{}, err
	}
	return users[0], nil
}

// UserPermissions ORs every assigned role's permission bits.
func (d *DB) UserPermissions(userID int64) (int, error) {
	rows, err := d.sql.Query(
		"SELECT r.permissions FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?",
		userID,
	)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	perms := 0
	for rows.Next() {
		var p int
		if err := rows.Scan(&p); err != nil {
			return 0, err
		}
		perms |= p
	}
	return perms, rows.Err()
}

// userRolesMap returns every assigned role, strongest first.
func (d *DB) userRolesMap(userIDs []int64) (map[int64][]Role, error) {
	out := map[int64][]Role{}
	if len(userIDs) == 0 {
		return out, nil
	}
	rows, err := d.sql.Query(
		"SELECT ur.user_id, r.id, r.name, r.color, r.position, r.permissions, r.created_at "+
			"FROM user_roles ur JOIN roles r ON r.id = ur.role_id "+
			"WHERE ur.user_id IN ("+placeholders(len(userIDs))+") "+
			"ORDER BY r.position DESC, r.id ASC",
		toAny(userIDs)...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid int64
		var r Role
		if err := rows.Scan(&uid, &r.ID, &r.Name, &r.Color, &r.Position, &r.Permissions, &r.CreatedAt); err != nil {
			return nil, err
		}
		out[uid] = append(out[uid], r)
	}
	return out, rows.Err()
}

func applyRoles(u *User, roles []Role, withIDs bool) {
	if len(roles) == 0 {
		return
	}
	u.RoleColor = roles[0].Color
	u.RoleName = roles[0].Name
	if withIDs {
		ids := make([]int64, 0, len(roles))
		for _, role := range roles {
			ids = append(ids, role.ID)
		}
		sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
		u.RoleIDs = ids
	}
}

// hydrateUsers fills role IDs and the strongest role for admin/member lists.
func (d *DB) hydrateUsers(users []User) error {
	if len(users) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(users))
	for _, u := range users {
		ids = append(ids, u.ID)
	}
	roles, err := d.userRolesMap(ids)
	if err != nil {
		return err
	}
	for i := range users {
		applyRoles(&users[i], roles[users[i].ID], true)
	}
	return nil
}

// hydrateMessageRoles only sets the display colour/name; message payloads don't
// need the full role ID list for every author.
func (d *DB) hydrateMessageRoles(messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	seen := map[int64]bool{}
	ids := []int64{}
	for _, message := range messages {
		if !seen[message.User.ID] {
			seen[message.User.ID] = true
			ids = append(ids, message.User.ID)
		}
	}
	roles, err := d.userRolesMap(ids)
	if err != nil {
		return err
	}
	for i := range messages {
		applyRoles(&messages[i].User, roles[messages[i].User.ID], false)
	}
	return nil
}

func (a *App) permissions(u User) int {
	if u.Admin {
		return PermAll
	}
	if u.Permissions != 0 {
		return u.Permissions
	}
	perms, err := a.db.UserPermissions(u.ID)
	if err != nil {
		return 0
	}
	return perms
}

func (a *App) can(u User, perm int) bool {
	return a.permissions(u)&perm != 0
}

// ---- handlers ----

func (a *App) listRoles(w http.ResponseWriter, r *http.Request, u User) {
	roles, err := a.db.ListRoles()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "Role se nepodařilo načíst")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"roles": roles})
}

func (a *App) createRole(w http.ResponseWriter, r *http.Request, u User) {
	var in struct {
		Name        string `json:"name"`
		Color       string `json:"color"`
		Permissions int    `json:"permissions"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	in.Name = strings.TrimSpace(in.Name)
	if !validRoleName(in.Name) {
		writeErr(w, http.StatusBadRequest, "Název role musí mít 1–32 znaků")
		return
	}
	if in.Color == "" {
		in.Color = "#99aab5"
	}
	if !roleColorPattern.MatchString(in.Color) {
		writeErr(w, http.StatusBadRequest, "Neplatná barva role")
		return
	}
	if !validPermissions(in.Permissions) {
		writeErr(w, http.StatusBadRequest, "Neplatná oprávnění")
		return
	}
	role, err := a.db.CreateRole(in.Name, in.Color, in.Permissions)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "roles:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"role": role})
}

func (a *App) updateRole(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if _, err := a.db.RoleByID(id); err != nil {
		writeErr(w, http.StatusNotFound, "Role neexistuje")
		return
	}
	var in struct {
		Name        *string `json:"name"`
		Color       *string `json:"color"`
		Permissions *int    `json:"permissions"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	if in.Name != nil {
		name := strings.TrimSpace(*in.Name)
		if !validRoleName(name) {
			writeErr(w, http.StatusBadRequest, "Název role musí mít 1–32 znaků")
			return
		}
		in.Name = &name
	}
	if in.Color != nil && !roleColorPattern.MatchString(*in.Color) {
		writeErr(w, http.StatusBadRequest, "Neplatná barva role")
		return
	}
	if in.Permissions != nil && !validPermissions(*in.Permissions) {
		writeErr(w, http.StatusBadRequest, "Neplatná oprávnění")
		return
	}
	role, err := a.db.UpdateRole(id, in.Name, in.Color, in.Permissions)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "roles:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"role": role})
}

func (a *App) deleteRole(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err := a.db.DeleteRole(id); err != nil {
		writeErr(w, http.StatusNotFound, "Role neexistuje")
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "roles:changed"})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) setUserRoles(w http.ResponseWriter, r *http.Request, u User) {
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	var in struct {
		RoleIDs []int64 `json:"roleIds"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, http.StatusBadRequest, "Neplatný požadavek")
		return
	}
	target, err := a.db.SetUserRoles(id, in.RoleIDs)
	if err != nil {
		writeErr(w, http.StatusBadRequest, err.Error())
		return
	}
	a.hub.broadcastAll(map[string]any{"type": "roles:changed"})
	writeJSON(w, http.StatusOK, map[string]any{"user": target})
}
