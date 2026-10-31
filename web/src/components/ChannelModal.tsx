import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { Channel, ChannelMember, User } from "../types";
import { toast } from "../toast";
import { Icon } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

export default function ChannelModal({
  open,
  mode,
  channel,
  me,
  onClose,
  onSaved,
}: {
  open: boolean;
  mode: "create" | "edit";
  channel: Channel | null;
  me: User;
  onClose: () => void;
  onSaved: (channel: Channel | null) => void;
}) {
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [error, setError] = useState("");
  const editingId = channel?.id ?? 0;

  useEffect(() => {
    if (!open) return;
    setError("");
    setSaving(false);
    setSearch("");
    if (mode === "edit" && channel) {
      setName(channel.name);
      setTopic(channel.topic);
      setVisibility(channel.visibility);
      setSelected(new Set());
    } else {
      setName("");
      setTopic("");
      setVisibility("public");
      setSelected(new Set());
    }
    setLoadingMembers(true);
    const requests: Promise<User[]> = api<{ users: User[] }>("/api/users").then((res) => res.users);
    const detail =
      mode === "edit" && channel
        ? api<{ channel: Channel; members: ChannelMember[] }>(`/api/channels/${channel.id}`)
        : null;
    Promise.all([requests, detail])
      .then(([allUsers, info]) => {
        setUsers(allUsers);
        if (info) {
          const ownerId = info.channel.ownerId;
          setSelected(new Set(info.members.filter((m) => m.id !== ownerId).map((m) => m.id)));
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Nepodařilo se načíst uživatele"))
      .finally(() => setLoadingMembers(false));
  }, [open, mode, editingId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return users;
    return users.filter(
      (u) => u.displayName.toLowerCase().includes(q) || u.username.toLowerCase().includes(q),
    );
  }, [users, search]);

  const toggleUser = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const save = async () => {
    setError("");
    const clean = name.trim().replace(/^#/, "");
    if (!clean) {
      setError("Zadej název kanálu");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: clean,
        topic: topic.trim(),
        visibility,
        memberIds: [...selected],
      };
      if (mode === "create") {
        const res = await api<{ channel: Channel }>("/api/channels", { method: "POST", body });
        toast.success(`Kanál #${res.channel.name} vytvořen`);
        onSaved(res.channel);
      } else if (channel) {
        const res = await api<{ channel: Channel }>(`/api/channels/${channel.id}`, {
          method: "PATCH",
          body,
        });
        toast.success("Kanál upraven");
        onSaved(res.channel);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uložení selhalo");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!channel) return;
    if (!window.confirm(`Smazat kanál #${channel.name}? Zprávy i soubory zmizí.`)) return;
    setSaving(true);
    setError("");
    try {
      await api(`/api/channels/${channel.id}`, { method: "DELETE" });
      toast.success("Kanál smazán");
      onSaved(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Smazání selhalo");
    } finally {
      setSaving(false);
    }
  };

  const isOwner = channel?.ownerId === me.id || me.admin;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={mode === "create" ? "Nový kanál" : `Upravit #${channel?.name ?? ""}`}
      subtitle={
        mode === "create"
          ? "Veřejný kanál vidí všichni, soukromý jen vybraní lidé."
          : "Změny se projeví hned všem členům."
      }
      footer={
        <>
          {mode === "edit" && isOwner && channel && (
            <button className="btn danger ghost" onClick={() => void remove()} disabled={saving}>
              <Icon name="trash" size={16} /> Smazat
            </button>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Zrušit
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving || loadingMembers}>
            {saving ? <Spinner size={16} /> : <Icon name={mode === "create" ? "plus" : "check"} size={16} />}
            {mode === "create" ? "Vytvořit" : "Uložit"}
          </button>
        </>
      }
    >
      <div className="formGrid">
        <label className="field">
          <span>Název</span>
          <div className="inputWrap">
            <Icon name="hash" size={16} />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="třeba_partaci"
              maxLength={40}
              autoFocus
            />
          </div>
        </label>
        <label className="field">
          <span>Téma (nepovinné)</span>
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder="O čem se tu mluví?"
            maxLength={160}
          />
        </label>
      </div>

      <div className="field">
        <span>Viditelnost</span>
        <div className="segmented">
          <button
            type="button"
            className={visibility === "public" ? "active" : ""}
            onClick={() => setVisibility("public")}
          >
            <Icon name="users" size={16} />
            <span>
              <strong>Veřejný</strong>
              <small>Všichni na serveru</small>
            </span>
          </button>
          <button
            type="button"
            className={visibility === "private" ? "active" : ""}
            onClick={() => setVisibility("private")}
          >
            <Icon name="lock" size={16} />
            <span>
              <strong>Soukromý</strong>
              <small>Jen pozvaní lidé</small>
            </span>
          </button>
        </div>
      </div>

      {visibility === "private" && (
        <div className="memberPicker">
          <div className="memberPickerHead">
            <span>Kdo má přístup</span>
            <span className="muted">
              {selected.size + 1} lidí
            </span>
          </div>
          <div className="inputWrap memberSearch">
            <Icon name="search" size={16} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Hledat lidi…"
            />
          </div>
          <div className="memberList">
            {filtered.map((user) => {
              const isMe = user.id === me.id;
              const checked = isMe || selected.has(user.id);
              return (
                <button
                  key={user.id}
                  type="button"
                  className={`memberRow${checked ? " checked" : ""}`}
                  onClick={() => {
                    if (!isMe) toggleUser(user.id);
                  }}
                  disabled={isMe}
                >
                  <Avatar name={user.displayName} color={user.avatarColor} size={32} />
                  <span className="memberRowInfo">
                    <strong>
                      {user.displayName}
                      {isMe && " (ty)"}
                    </strong>
                    <small>@{user.username}</small>
                  </span>
                  <span className={`checkBox${checked ? " on" : ""}`}>
                    {checked && <Icon name="check" size={13} />}
                  </span>
                </button>
              );
            })}
            {loadingMembers && (
              <p className="muted small">
                <Spinner size={14} /> Načítám členy…
              </p>
            )}
            {!loadingMembers && filtered.length === 0 && <p className="muted small">Nikdo nenalezen.</p>}
          </div>
        </div>
      )}

      {visibility === "public" && (
        <p className="hintBox">
          <Icon name="info" size={15} /> Do veřejného kanálu se automaticky přidají všichni uživatelé, i ti,
          kteří přijdou později.
        </p>
      )}

      {error && <div className="formError">{error}</div>}
    </Modal>
  );
}
