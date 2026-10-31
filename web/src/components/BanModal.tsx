import { useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { User } from "../types";
import { Icon } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

const DURATIONS: { label: string; hours: number }[] = [
  { label: "Trvale", hours: 0 },
  { label: "1 hodina", hours: 1 },
  { label: "24 hodin", hours: 24 },
  { label: "7 dní", hours: 24 * 7 },
  { label: "30 dní", hours: 24 * 30 },
];

export default function BanModal({
  user,
  onClose,
  onBanned,
}: {
  user: User;
  onClose: () => void;
  onBanned: (user: User) => void;
}) {
  const [reason, setReason] = useState("");
  const [hours, setHours] = useState(0);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api<{ user: User }>(`/api/users/${user.id}/ban`, {
        method: "POST",
        body: { reason: reason.trim(), hours },
      });
      onBanned(res.user);
      toast.success(`${res.user.displayName} byl zabanován`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ban se nepovedl");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Zabanovat účet"
      subtitle="Uživatel se okamžitě odhlásí a nebude se moct přihlásit."
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Zrušit
          </button>
          <button className="btn dangerSolid" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="ban" size={16} />} Zabanovat
          </button>
        </>
      }
    >
      <div className="banTarget">
        <Avatar name={user.displayName} color={user.avatarColor} avatarId={user.avatarId} size={44} />
        <div>
          <strong>{user.displayName}</strong>
          <span>@{user.username}</span>
        </div>
        <span className="banTargetTag">
          <Icon name="alert" size={13} /> ban
        </span>
      </div>

      <label className="field">
        <span>Důvod</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          maxLength={200}
          placeholder="Proč ban? Uvidí ho při přihlášení."
        />
        <small>{reason.length}/200</small>
      </label>

      <div className="field">
        <span>Délka</span>
        <div className="banDurations">
          {DURATIONS.map((duration) => (
            <button
              key={duration.hours}
              type="button"
              className={`banDuration${hours === duration.hours ? " active" : ""}`}
              onClick={() => setHours(duration.hours)}
            >
              {duration.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hintBox">
        <Icon name="info" size={15} />
        {hours === 0
          ? "Trvalý ban platí, dokud ho ručně nezrušíš."
          : `Ban vyprší za ${hours < 24 ? `${hours} h` : `${Math.round(hours / 24)} dní`} a účet se sám odemkne.`}
      </div>
    </Modal>
  );
}
