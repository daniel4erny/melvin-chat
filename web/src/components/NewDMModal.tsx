import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Channel, User } from "../types";
import { Icon } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

export default function NewDMModal({
  open,
  me,
  onClose,
  onCreated,
}: {
  open: boolean;
  me: User;
  onClose: () => void;
  onCreated: (channel: Channel) => void;
}) {
  const [users, setUsers] = useState<User[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(new Set());
    setError("");
    setLoading(true);
    api<{ users: User[] }>("/api/users")
      .then((res) => setUsers(res.users.filter((user) => user.id !== me.id)))
      .catch((err) => setError(err instanceof Error ? err.message : "Lidi se nepodařilo načíst"))
      .finally(() => setLoading(false));
  }, [open, me.id]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (user) => user.username.toLowerCase().includes(q) || user.displayName.toLowerCase().includes(q),
    );
  }, [users, query]);

  const toggle = (user: User) => {
    if (user.banned) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(user.id)) next.delete(user.id);
      else next.add(user.id);
      return next;
    });
  };

  const create = async () => {
    if (selected.size === 0) {
      setError("Vyber alespoň jednoho člověka");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const res = await api<{ channel: Channel }>("/api/dms", {
        method: "POST",
        body: { userIds: [...selected] },
      });
      onCreated(res.channel);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Konverzaci se nepodařilo otevřít");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nová zpráva"
      subtitle="Vyber jednoho člověka pro DM, nebo víc lidí pro skupinovou konverzaci."
      footer={
        <>
          <span className="muted small">
            {selected.size === 0
              ? "Nikdo nevybrán"
              : selected.size === 1
                ? "Přímá zpráva"
                : `Skupina · ${selected.size + 1} lidí`}
          </span>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Zrušit
          </button>
          <button className="btn primary" onClick={() => void create()} disabled={saving || selected.size === 0}>
            {saving ? <Spinner size={16} /> : <Icon name="send" size={16} />} Otevřít
          </button>
        </>
      }
    >
      <div className="newDM">
        <div className="inputWrap memberSearch">
          <Icon name="search" size={16} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Hledat lidi…"
            autoFocus
          />
        </div>
        <div className="newDMList">
          {filtered.map((user) => {
            const checked = selected.has(user.id);
            return (
              <button
                key={user.id}
                type="button"
                className={`memberRow${checked ? " checked" : ""}${user.banned ? " disabled" : ""}`}
                onClick={() => toggle(user)}
                disabled={user.banned}
              >
                <Avatar name={user.displayName} color={user.avatarColor} avatarId={user.avatarId} size={34} />
                <span className="memberRowInfo">
                  <strong>{user.displayName}</strong>
                  <small>
                    @{user.username}
                    {user.banned ? " · zabanován" : ""}
                  </small>
                </span>
                <span className={`checkBox${checked ? " on" : ""}`}>{checked && <Icon name="check" size={13} />}</span>
              </button>
            );
          })}
          {loading && (
            <p className="muted small">
              <Spinner size={14} /> Načítám lidi…
            </p>
          )}
          {!loading && filtered.length === 0 && <p className="muted small">Nikdo nenalezen.</p>}
        </div>
        {error && <div className="formError">{error}</div>}
      </div>
    </Modal>
  );
}
