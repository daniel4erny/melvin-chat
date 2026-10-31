import { useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { User } from "../types";
import { formatDateTime } from "../utils";
import { Icon } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

export default function ProfileCard({
  user,
  me,
  online,
  onClose,
  onUpdated,
  onEditSelf,
}: {
  user: User;
  me: User;
  online?: boolean;
  onClose: () => void;
  onUpdated: (user: User) => void;
  onEditSelf: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const self = user.id === me.id;

  const toggleAdmin = async () => {
    setSaving(true);
    try {
      const res = await api<{ user: User }>(`/api/users/${user.id}`, {
        method: "PATCH",
        body: { admin: !user.admin },
      });
      onUpdated(res.user);
      toast.success(res.user.admin ? `${res.user.displayName} je teď admin` : `${res.user.displayName} už není admin`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Změna práv selhala");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Profil">
      <div className="profileCard">
        <div className="profileBanner" style={{ background: user.avatarColor }} />
        <div className="profileIdentity">
          <Avatar name={user.displayName} color={user.avatarColor} size={74} online={online} />
          <div className="profileNames">
            <h3>
              {user.displayName}
              {user.admin && <span className="adminTag">admin</span>}
              {self && <span className="selfTag">ty</span>}
            </h3>
            <p>@{user.username}</p>
            <span className={`profilePresence${online ? " online" : ""}`}>
              <span className="presenceDot" /> {online ? "online" : "offline"}
            </span>
          </div>
        </div>

        <div className="profileSection">
          <h4>O mně</h4>
          <p className={user.bio ? "" : "muted"}>{user.bio || "Zatím žádné bio."}</p>
        </div>

        <div className="profileMeta">
          <span>
            <Icon name="clock" size={14} /> Na Melvinu od {formatDateTime(user.createdAt)}
          </span>
          <span>
            <Icon name="user" size={14} /> ID {user.id}
          </span>
        </div>

        <div className="profileActions">
          {self ? (
            <button className="btn primary" onClick={onEditSelf}>
              <Icon name="settings" size={16} /> Upravit profil
            </button>
          ) : (
            me.admin && (
              <button className={`btn${user.admin ? " danger ghost" : " primary"}`} onClick={() => void toggleAdmin()} disabled={saving}>
                {saving ? (
                  <Spinner size={16} />
                ) : (
                  <Icon name={user.admin ? "userMinus" : "userPlus"} size={16} />
                )}
                {user.admin ? "Odebrat admina" : "Udělat adminem"}
              </button>
            )
          )}
          <button className="btn ghost" onClick={onClose}>
            Zavřít
          </button>
        </div>
      </div>
    </Modal>
  );
}
