import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { User, UserProfileResponse } from "../types";
import { formatDateTime, formatLastSeen, plural, timeoutLabel } from "../utils";
import BanModal from "./BanModal";
import TimeoutModal from "./TimeoutModal";
import { Icon } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

function banUntilLabel(until?: number): string {
  if (!until) return "trvale";
  return `do ${formatDateTime(until)}`;
}

export default function ProfileCard({
  user,
  me,
  online,
  onClose,
  onUpdated,
  onEditSelf,
  onViewMessages,
  onMessage,
  onOpenChannel,
}: {
  user: User;
  me: User;
  online?: boolean;
  onClose: () => void;
  onUpdated: (user: User) => void;
  onEditSelf: () => void;
  onViewMessages?: (user: User) => void;
  onMessage?: (user: User) => void;
  onOpenChannel?: (channelId: number) => void;
}) {
  const [profile, setProfile] = useState<UserProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [banOpen, setBanOpen] = useState(false);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const self = user.id === me.id;
  const canModerate = me.admin && !self;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api<UserProfileResponse>(`/api/users/${user.id}/profile`)
      .then((res) => {
        if (!cancelled) setProfile(res);
      })
      .catch(() => {
        if (!cancelled) setProfile(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const shown = profile && profile.user.id === user.id ? { ...profile.user, ...user } : user;
  const stats = profile?.stats;
  const isOnline = online ?? profile?.online ?? false;
  const timeoutActive = Boolean(shown.timeoutUntil && shown.timeoutUntil > Date.now());
  const timeoutLeft = shown.timeoutUntil ? shown.timeoutUntil - Date.now() : 0;

  const toggleAdmin = async () => {
    setSaving(true);
    try {
      const res = await api<{ user: User }>(`/api/users/${shown.id}`, {
        method: "PATCH",
        body: { admin: !shown.admin },
      });
      onUpdated(res.user);
      setProfile((prev) => (prev ? { ...prev, user: res.user } : prev));
      toast.success(res.user.admin ? `${res.user.displayName} je teď admin` : `${res.user.displayName} už není admin`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Změna práv selhala");
    } finally {
      setSaving(false);
    }
  };

  const unban = async () => {
    setSaving(true);
    try {
      const res = await api<{ user: User }>(`/api/users/${shown.id}/unban`, {
        method: "POST",
        body: {},
      });
      onUpdated(res.user);
      setProfile((prev) => (prev ? { ...prev, user: res.user } : prev));
      toast.success(`${res.user.displayName} je odbanovaný`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Odbanování selhalo");
    } finally {
      setSaving(false);
    }
  };

  const clearTimeout = async () => {
    setSaving(true);
    try {
      const res = await api<{ user: User }>(`/api/users/${shown.id}/timeout`, { method: "DELETE" });
      onUpdated(res.user);
      setProfile((prev) => (prev ? { ...prev, user: res.user, timeoutLeft: 0 } : prev));
      toast.success(`Timeout pro ${res.user.displayName} zrušen`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Timeout se nepodařilo zrušit");
    } finally {
      setSaving(false);
    }
  };

  const banner = `linear-gradient(120deg, ${shown.avatarColor}, color-mix(in srgb, ${shown.avatarColor} 45%, #5865f2))`;

  return (
    <>
      <Modal open onClose={onClose} title="Profil" hideHead>
        <div className="profileV2">
          <div className="profileBannerV2" style={{ background: banner }}>
            <span className="profileBannerGlow" />
          </div>

          <div className="profileHero">
            <Avatar
              name={shown.displayName}
              color={shown.avatarColor}
              avatarId={shown.avatarId}
              size={88}
              online={isOnline}
            />
            <div className="profileHeroText">
              <h3>
                {shown.displayName}
                {shown.admin && <span className="adminTag">admin</span>}
                {timeoutActive && <span className="timeoutTag">timeout</span>}
                {shown.banned && <span className="banTag">ban</span>}
                {self && <span className="selfTag">ty</span>}
              </h3>
              <p>@{shown.username}</p>
              <span className={`profilePresence${isOnline ? " online" : ""}`}>
                <span className="presenceDot" />
                {isOnline ? "online" : `naposledy ${formatLastSeen(shown.lastSeen)}`}
              </span>
            </div>
          </div>

          {(shown.statusEmoji || shown.statusText) && (
            <div className="profileStatus">
              {shown.statusEmoji && <span className="profileStatusEmoji">{shown.statusEmoji}</span>}
              <span>{shown.statusText || "Vlastní stav"}</span>
            </div>
          )}

          {timeoutActive && (
            <div className="timeoutBannerV2">
              <span className="timeoutBannerIcon">
                <Icon name="clock" size={18} />
              </span>
              <div>
                <strong>Timeout · zbývá {timeoutLabel(timeoutLeft)}</strong>
                <p>{shown.timeoutReason || "Bez uvedeného důvodu"}</p>
                <small>do {formatDateTime(shown.timeoutUntil!)}</small>
              </div>
              {me.admin && (
                <button className="btn tiny ghost" onClick={() => void clearTimeout()} disabled={saving}>
                  Zrušit
                </button>
              )}
            </div>
          )}

          {shown.banned && (
            <div className="banBanner">
              <span className="banBannerIcon">
                <Icon name="ban" size={18} />
              </span>
              <div>
                <strong>Účet je zabanovaný</strong>
                <p>{shown.banReason || "Bez uvedeného důvodu"}</p>
                <small>{banUntilLabel(shown.bannedUntil)}</small>
              </div>
            </div>
          )}

          {!self && (onMessage || onViewMessages) && (
            <div className="profileQuickActions">
              {onMessage && (
                <button className="btn primary" onClick={() => onMessage(shown)}>
                  <Icon name="send" size={16} /> Napsat zprávu
                </button>
              )}
              {onViewMessages && (
                <button className="btn ghost" onClick={() => onViewMessages(shown)}>
                  <Icon name="search" size={16} /> Zobrazit zprávy
                </button>
              )}
            </div>
          )}

          <div className="profileSection">
            <h4>O mně</h4>
            <p className={shown.bio ? "" : "muted"}>{shown.bio || "Zatím žádné bio."}</p>
          </div>

          {(shown.pronouns || shown.location || shown.website) && (
            <div className="profileInfoRows">
              {shown.pronouns && (
                <span>
                  <Icon name="user" size={14} /> {shown.pronouns}
                </span>
              )}
              {shown.location && (
                <span>
                  <Icon name="pin" size={14} /> {shown.location}
                </span>
              )}
              {shown.website && (
                <a href={shown.website} target="_blank" rel="noreferrer noopener">
                  <Icon name="link" size={14} /> {shown.website.replace(/^https?:\/\//, "")}
                </a>
              )}
            </div>
          )}

          {stats && (
            <div className="profileStats">
              <div>
                <strong>{stats.messages}</strong>
                <span>{plural(stats.messages, "zpráva", "zprávy", "zpráv")}</span>
              </div>
              <div>
                <strong>{stats.reactions}</strong>
                <span>{plural(stats.reactions, "reakce", "reakce", "reakcí")}</span>
              </div>
              <div>
                <strong>{stats.channels}</strong>
                <span>{plural(stats.channels, "kanál", "kanály", "kanálů")}</span>
              </div>
            </div>
          )}

          {stats && stats.sharedChannels.length > 0 && (
            <div className="profileSection">
              <h4>Společné kanály</h4>
              <div className="sharedChannels">
                {stats.sharedChannels.map((channel) => (
                  <button
                    key={channel.id}
                    type="button"
                    className="sharedChannel"
                    onClick={() => {
                      onOpenChannel?.(channel.id);
                      onClose();
                    }}
                  >
                    <Icon name={channel.visibility === "private" ? "lock" : "hash"} size={13} />
                    {channel.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="profileMeta">
            <span>
              <Icon name="clock" size={14} /> Na Melvinu od {formatDateTime(shown.createdAt)}
            </span>
            <span>
              <Icon name="user" size={14} /> ID {shown.id}
            </span>
          </div>

          <div className="profileActions">
            {self ? (
              <button className="btn primary" onClick={onEditSelf}>
                <Icon name="settings" size={16} /> Upravit profil
              </button>
            ) : (
              canModerate && (
                <>
                  <button
                    className={`btn${shown.admin ? " danger ghost" : " primary"}`}
                    onClick={() => void toggleAdmin()}
                    disabled={saving}
                  >
                    {saving ? (
                      <Spinner size={16} />
                    ) : (
                      <Icon name={shown.admin ? "userMinus" : "userPlus"} size={16} />
                    )}
                    {shown.admin ? "Odebrat admina" : "Udělat adminem"}
                  </button>
                  <button
                    className={`btn${timeoutActive ? "" : " danger ghost"}`}
                    onClick={() => setTimeoutOpen(true)}
                    disabled={saving || shown.admin}
                    title={shown.admin ? "Adminovi nejde dát timeout" : "Dočasně umlčet"}
                  >
                    <Icon name="clock" size={16} />
                    {timeoutActive ? "Změnit timeout" : "Timeout"}
                  </button>
                  {shown.banned ? (
                    <button className="btn" onClick={() => void unban()} disabled={saving}>
                      <Icon name="check" size={16} /> Odbanovat
                    </button>
                  ) : (
                    <button
                      className="btn danger"
                      onClick={() => setBanOpen(true)}
                      disabled={saving || shown.admin}
                      title={shown.admin ? "Admina nejde zabanovat" : "Zabanovat účet"}
                    >
                      <Icon name="ban" size={16} /> Zabanovat
                    </button>
                  )}
                </>
              )
            )}
          </div>

          {loading && (
            <div className="profileLoading">
              <Spinner size={16} /> Načítám profil…
            </div>
          )}
        </div>
      </Modal>

      {banOpen && (
        <BanModal
          user={shown}
          onClose={() => setBanOpen(false)}
          onBanned={(updated) => {
            onUpdated(updated);
            setProfile((prev) => (prev ? { ...prev, user: updated } : prev));
            setBanOpen(false);
          }}
        />
      )}

      {timeoutOpen && (
        <TimeoutModal
          user={shown}
          onClose={() => setTimeoutOpen(false)}
          onDone={(updated) => {
            onUpdated(updated);
            setProfile((prev) => (prev ? { ...prev, user: updated, timeoutLeft: updated.timeoutUntil ? updated.timeoutUntil - Date.now() : 0 } : prev));
          }}
        />
      )}
    </>
  );
}
