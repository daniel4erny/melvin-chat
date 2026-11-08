import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  PERM_MANAGE_CHANNELS,
  PERM_MANAGE_MEMBERS,
  PERM_MANAGE_MESSAGES,
  type Role,
  type User,
} from "../types";
import { toast } from "../toast";
import { Icon } from "./Icon";
import { Avatar, Spinner } from "./ui";

const COLORS = ["#99aab5", "#5865f2", "#eb459e", "#ed4245", "#faa61a", "#3ba55d", "#00b0f4", "#9b59b6"];
const PERMISSIONS = [
  { bit: PERM_MANAGE_CHANNELS, label: "Správa kanálů", hint: "úpravy a mazání cizích kanálů a kategorií" },
  { bit: PERM_MANAGE_MESSAGES, label: "Správa zpráv", hint: "mazání cizích zpráv a připínání" },
  { bit: PERM_MANAGE_MEMBERS, label: "Timeouty", hint: "udělování a rušení timeoutů" },
];

function permissionLabels(perms: number): string[] {
  return PERMISSIONS.filter((permission) => perms & permission.bit).map((permission) => permission.label);
}

export default function RolesPanel({ me }: { me: User }) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyUser, setBusyUser] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[1]!);
  const [perms, setPerms] = useState(0);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState(COLORS[1]!);
  const [editPerms, setEditPerms] = useState(0);

  const load = async () => {
    setLoading(true);
    setError("");
    try {
      const [roleRes, userRes] = await Promise.all([
        api<{ roles: Role[] }>("/api/roles"),
        api<{ users: User[] }>("/api/users"),
      ]);
      setRoles(roleRes.roles);
      setUsers(userRes.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Role se nepodařilo načíst");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (user) => user.username.toLowerCase().includes(q) || user.displayName.toLowerCase().includes(q),
    );
  }, [users, search]);

  const togglePerm = (value: number, bit: number, setter: (next: number) => void) => {
    setter(value & bit ? value & ~bit : value | bit);
  };

  const createRole = async () => {
    const clean = name.trim();
    if (!clean) {
      setError("Zadej název role");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/roles", { method: "POST", body: { name: clean, color, permissions: perms } });
      setName("");
      setPerms(0);
      await load();
      toast.success(`Role ${clean} vytvořena`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Roli se nepodařilo vytvořit");
    } finally {
      setBusy(false);
    }
  };

  const beginEdit = (role: Role) => {
    setEditingId(role.id);
    setEditName(role.name);
    setEditColor(role.color);
    setEditPerms(role.permissions);
  };

  const saveRole = async (role: Role) => {
    setBusy(true);
    setError("");
    try {
      await api(`/api/roles/${role.id}`, {
        method: "PATCH",
        body: { name: editName.trim(), color: editColor, permissions: editPerms },
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Roli se nepodařilo upravit");
    } finally {
      setBusy(false);
    }
  };

  const removeRole = async (role: Role) => {
    if (!window.confirm(`Smazat roli ${role.name}? Zmizí i všem, kdo ji mají.`)) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/roles/${role.id}`, { method: "DELETE" });
      await load();
      toast.success("Role smazána");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Roli se nepodařilo smazat");
    } finally {
      setBusy(false);
    }
  };

  const toggleUserRole = async (user: User, role: Role) => {
    const current = new Set(user.roleIds ?? []);
    if (current.has(role.id)) current.delete(role.id);
    else current.add(role.id);
    setBusyUser(user.id);
    setError("");
    try {
      const res = await api<{ user: User }>(`/api/users/${user.id}/roles`, {
        method: "POST",
        body: { roleIds: [...current] },
      });
      setUsers((prev) => prev.map((entry) => (entry.id === user.id ? { ...entry, ...res.user } : entry)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Role se nepodařilo přiřadit");
    } finally {
      setBusyUser(null);
    }
  };

  const permissionPicker = (value: number, setter: (next: number) => void) => (
    <div className="permPicker">
      {PERMISSIONS.map((permission) => (
        <button
          key={permission.bit}
          type="button"
          className={`permChip${value & permission.bit ? " on" : ""}`}
          onClick={() => togglePerm(value, permission.bit, setter)}
          title={permission.hint}
        >
          <Icon name="check" size={12} /> {permission.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="settingsSection rolesPanel">
      <div className="rolesIntro">
        <span className="rolesIntroIcon">
          <Icon name="shield" size={20} />
        </span>
        <div>
          <strong>Role a oprávnění</strong>
          <p>
            Role mění barvu jména v chatu i v seznamu členů. Oprávnění platí jen pro lidi, kterým
            roli přiřadíš; admin má vždy všechno.
          </p>
        </div>
      </div>

      {loading && (
        <p className="muted small">
          <Spinner size={15} /> Načítám role…
        </p>
      )}
      {error && <div className="formError">{error}</div>}

      <div className="settingsBlock">
        <h4>
          <Icon name="plus" size={15} /> Nová role
        </h4>
        <div className="roleCreateGrid">
          <label className="field">
            <span>Název</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={32}
              placeholder="třeba Moderátor"
            />
          </label>
          <div className="field">
            <span>Barva jména</span>
            <div className="colorRow">
              {COLORS.map((choice) => (
                <button
                  key={choice}
                  type="button"
                  className={`colorDot${color === choice ? " active" : ""}`}
                  style={{ background: choice }}
                  onClick={() => setColor(choice)}
                  aria-label={`Barva ${choice}`}
                />
              ))}
              <input
                type="color"
                className="colorInput"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                aria-label="Vlastní barva"
              />
            </div>
          </div>
        </div>
        {permissionPicker(perms, setPerms)}
        <div className="roleCreateFoot">
          <span className="rolePreview" style={{ color }}>
            {name.trim() || "Náhled jména"}
          </span>
          <span className="spacer" />
          <button className="btn primary" onClick={() => void createRole()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Vytvořit roli
          </button>
        </div>
      </div>

      <div className="settingsBlock">
        <h4>
          <Icon name="shield" size={15} /> Role na serveru · {roles.length}
        </h4>
        <div className="roleList">
          {roles.map((role) => (
            <div className="roleRow" key={role.id}>
              {editingId === role.id ? (
                <div className="roleEdit">
                  <input
                    className="roleNameInput"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={32}
                    autoFocus
                  />
                  <div className="colorRow">
                    {COLORS.map((choice) => (
                      <button
                        key={choice}
                        type="button"
                        className={`colorDot${editColor === choice ? " active" : ""}`}
                        style={{ background: choice }}
                        onClick={() => setEditColor(choice)}
                        aria-label={`Barva ${choice}`}
                      />
                    ))}
                    <input
                      type="color"
                      className="colorInput"
                      value={editColor}
                      onChange={(e) => setEditColor(e.target.value)}
                      aria-label="Vlastní barva"
                    />
                  </div>
                  {permissionPicker(editPerms, setEditPerms)}
                  <div className="row gap">
                    <button className="btn tiny primary" onClick={() => void saveRole(role)} disabled={busy}>
                      <Icon name="check" size={14} /> Uložit
                    </button>
                    <button className="btn tiny ghost" onClick={() => setEditingId(null)}>
                      Zrušit
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <span className="roleDot" style={{ background: role.color }} />
                  <div className="roleRowText">
                    <strong style={{ color: role.color }}>{role.name}</strong>
                    <small>
                      {permissionLabels(role.permissions).join(" · ") || "bez oprávnění"}
                    </small>
                  </div>
                  <button className="iconBtn" onClick={() => beginEdit(role)} title="Upravit" aria-label="Upravit">
                    <Icon name="pencil" size={15} />
                  </button>
                  <button
                    className="iconBtn danger"
                    onClick={() => void removeRole(role)}
                    title="Smazat"
                    aria-label="Smazat"
                    disabled={busy}
                  >
                    <Icon name="trash" size={15} />
                  </button>
                </>
              )}
            </div>
          ))}
          {!loading && roles.length === 0 && (
            <p className="muted small">Zatím žádné role. Vytvoř první nahoře.</p>
          )}
        </div>
      </div>

      <div className="settingsBlock">
        <div className="row spaceBetween rolesMembersHead">
          <h4>
            <Icon name="users" size={15} /> Přiřazení rolí
          </h4>
          <div className="inputWrap rolesSearch">
            <Icon name="search" size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Hledat lidi…" />
          </div>
        </div>
        {roles.length === 0 ? (
          <p className="muted small">Nejdřív vytvoř roli, pak ji můžeš lidem přiřadit.</p>
        ) : (
          <div className="roleMembers">
            {filteredUsers.map((user) => (
              <div className="roleMemberRow" key={user.id}>
                <Avatar name={user.displayName} color={user.avatarColor} avatarId={user.avatarId} size={32} />
                <div className="roleMemberInfo">
                  <strong style={{ color: user.roleColor || undefined }}>
                    {user.displayName}
                    {user.id === me.id && <span className="selfMark">ty</span>}
                  </strong>
                  <small>@{user.username}</small>
                </div>
                <div className="roleChips">
                  {roles.map((role) => {
                    const assigned = user.roleIds?.includes(role.id) ?? false;
                    return (
                      <button
                        key={role.id}
                        type="button"
                        className={`roleChip${assigned ? " on" : ""}`}
                        style={assigned ? { borderColor: role.color, color: role.color } : undefined}
                        onClick={() => void toggleUserRole(user, role)}
                        disabled={busyUser === user.id}
                        title={assigned ? `Odebrat roli ${role.name}` : `Přidat roli ${role.name}`}
                      >
                        {busyUser === user.id ? <Spinner size={11} /> : <span className="roleChipDot" style={{ background: role.color }} />}
                        {role.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            {filteredUsers.length === 0 && <p className="muted small">Nikdo nenalezen.</p>}
          </div>
        )}
      </div>
    </div>
  );
}
