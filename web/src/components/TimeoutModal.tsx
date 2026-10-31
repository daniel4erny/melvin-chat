import { useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { User } from "../types";
import { Icon } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

const DURATIONS: { label: string; minutes: number }[] = [
  { label: "60 sekund", minutes: 1 },
  { label: "5 minut", minutes: 5 },
  { label: "10 minut", minutes: 10 },
  { label: "1 hodina", minutes: 60 },
  { label: "1 den", minutes: 60 * 24 },
  { label: "7 dní", minutes: 60 * 24 * 7 },
  { label: "28 dní", minutes: 60 * 24 * 28 },
];

export default function TimeoutModal({
  user,
  onClose,
  onDone,
}: {
  user: User;
  onClose: () => void;
  onDone: (user: User) => void;
}) {
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api<{ user: User }>(`/api/users/${user.id}/timeout`, {
        method: "POST",
        body: { minutes, reason: reason.trim() },
      });
      onDone(res.user);
      toast.success(`${res.user.displayName} má timeout na ${minutes >= 1440 ? `${Math.round(minutes / 1440)} dní` : minutes >= 60 ? `${Math.round(minutes / 60)} h` : `${minutes} min`}`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Timeout se nepovedl");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Dát timeout"
      subtitle="Uživatel zůstane přihlášený a může číst, ale nemůže psát, reagovat ani mluvit v hovoru."
      footer={
        <>
          <button className="btn ghost" onClick={onClose} disabled={busy}>
            Zrušit
          </button>
          <button className="btn dangerSolid" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="clock" size={16} />} Dát timeout
          </button>
        </>
      }
    >
      <div className="banTarget timeoutTarget">
        <Avatar name={user.displayName} color={user.avatarColor} avatarId={user.avatarId} size={44} />
        <div>
          <strong>{user.displayName}</strong>
          <span>@{user.username}</span>
        </div>
        <span className="banTargetTag timeoutTag">
          <Icon name="clock" size={13} /> timeout
        </span>
      </div>

      <label className="field">
        <span>Důvod (nepovinné)</span>
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={2}
          maxLength={200}
          placeholder="Proč timeout? Uvidí ho v profilu i v oznámení."
        />
        <small>{reason.length}/200</small>
      </label>

      <div className="field">
        <span>Délka</span>
        <div className="banDurations">
          {DURATIONS.map((duration) => (
            <button
              key={duration.minutes}
              type="button"
              className={`banDuration${minutes === duration.minutes ? " active" : ""}`}
              onClick={() => setMinutes(duration.minutes)}
            >
              {duration.label}
            </button>
          ))}
        </div>
      </div>

      <div className="hintBox">
        <Icon name="info" size={15} />
        Po vypršení se účet sám odemkne. Timeout jde kdykoliv zrušit v profilu uživatele.
      </div>
    </Modal>
  );
}
