import { useEffect, useState } from "react";
import { api, getServer, removeAvatar, setServer, uploadAvatar } from "../api";
import { applyTheme } from "../theme";
import { toast } from "../toast";
import { clearLogs, downloadLogs, getLogs, type LogEntry } from "../logs";
import type { Invite, User, UserSettings, WSStatus } from "../types";
import { formatDateTime, playPing, prepareAvatar, validColor } from "../utils";
import BanModal from "./BanModal";
import TimeoutModal from "./TimeoutModal";
import { Icon, type IconName } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

const ACCENTS = ["#5865f2", "#1abc9c", "#eb459e", "#f0b232", "#3ba55c", "#ed4245", "#00a8fc", "#a78bfa"];
const COLOR_CHOICES = ["#5865f2", "#1abc9c", "#eb459e", "#f0b232", "#3ba55c", "#ed4245", "#00a8fc", "#a78bfa", "#94a3b8"];

type Tab = "profile" | "appearance" | "chat" | "privacy" | "users" | "invites" | "system";

// Accept a bare domain the way people write it; the API requires a scheme.
function normalizeWebsite(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

const TABS: { id: Tab; label: string; icon: IconName; admin?: boolean }[] = [
  { id: "profile", label: "Profil", icon: "user" },
  { id: "appearance", label: "Vzhled", icon: "palette" },
  { id: "chat", label: "Chat", icon: "bell" },
  { id: "privacy", label: "Soukromí", icon: "shield" },
  { id: "users", label: "Uživatelé", icon: "users", admin: true },
  { id: "invites", label: "Pozvánky", icon: "link", admin: true },
  { id: "system", label: "Systém", icon: "server" },
];

export default function SettingsModal({
  open,
  onClose,
  user,
  wsStatus,
  version,
  maxUploadMB,
  onSave,
  onLogout,
  onRefreshUser,
}: {
  open: boolean;
  onClose: () => void;
  user: User;
  wsStatus: WSStatus;
  version: string;
  maxUploadMB: number;
  onSave: (patch: Record<string, unknown>) => Promise<User>;
  onLogout: () => void;
  onRefreshUser: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [avatarId, setAvatarId] = useState(user.avatarId);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [pronouns, setPronouns] = useState(user.pronouns ?? "");
  const [place, setPlace] = useState(user.location ?? "");
  const [website, setWebsite] = useState(user.website ?? "");
  const [statusEmoji, setStatusEmoji] = useState(user.statusEmoji);
  const [statusText, setStatusText] = useState(user.statusText);
  const [settings, setSettings] = useState<UserSettings>(user.settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [serverValue, setServerValue] = useState(getServer());
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [users, setUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [userQuery, setUserQuery] = useState("");
  const [banTarget, setBanTarget] = useState<User | null>(null);
  const [timeoutTarget, setTimeoutTarget] = useState<User | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [inviteNote, setInviteNote] = useState("");
  const [inviteUses, setInviteUses] = useState(1);
  const [inviteExpiry, setInviteExpiry] = useState(0);
  const [creatingInvite, setCreatingInvite] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDisplayName(user.displayName);
    setBio(user.bio);
    setAvatarColor(user.avatarColor);
    setAvatarId(user.avatarId);
    setPronouns(user.pronouns ?? "");
    setPlace(user.location ?? "");
    setWebsite(user.website ?? "");
    setStatusEmoji(user.statusEmoji);
    setStatusText(user.statusText);
    setSettings(user.settings);
    setError("");
    setTab("profile");
    setCurrentPassword("");
    setNewPassword("");
    setServerValue(getServer());
    // Only reset when the dialog opens; live profile broadcasts must not wipe
    // whatever the user is currently editing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) applyTheme(settings);
  }, [settings, open]);

  useEffect(() => {
    if (open && tab === "system") setLogs(getLogs());
  }, [open, tab]);

  useEffect(() => {
    if (!open || !user.admin) return;
    if (tab === "users") void loadUsers();
    if (tab === "invites") void loadInvites();
  }, [open, tab, user.admin]);

  async function loadUsers() {
    setUsersLoading(true);
    try {
      const res = await api<{ users: User[] }>("/api/users");
      setUsers(res.users);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Uživatele se nepodařilo načíst");
    } finally {
      setUsersLoading(false);
    }
  }

  async function loadInvites() {
    setInvitesLoading(true);
    try {
      const res = await api<{ invites: Invite[] }>("/api/invites");
      setInvites(res.invites);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pozvánky se nepodařilo načíst");
    } finally {
      setInvitesLoading(false);
    }
  }

  async function toggleAdmin(target: User) {
    setBusyUser(target.id);
    try {
      const res = await api<{ user: User }>(`/api/users/${target.id}`, {
        method: "PATCH",
        body: { admin: !target.admin },
      });
      setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)));
      if (res.user.id === user.id) await onRefreshUser();
      toast.success(res.user.admin ? `${res.user.displayName} je teď admin` : `${res.user.displayName} už není admin`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Změna práv selhala");
    } finally {
      setBusyUser(null);
    }
  }

  async function unbanUser(target: User) {
    setBusyUser(target.id);
    try {
      const res = await api<{ user: User }>(`/api/users/${target.id}/unban`, {
        method: "POST",
        body: {},
      });
      setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)));
      toast.success(`${res.user.displayName} je odbanovaný`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Odbanování selhalo");
    } finally {
      setBusyUser(null);
    }
  }

  async function createInvite() {
    if (creatingInvite) return;
    setCreatingInvite(true);
    try {
      const res = await api<{ invite: Invite }>("/api/invites", {
        method: "POST",
        body: { note: inviteNote.trim(), maxUses: inviteUses, expiresInHours: inviteExpiry },
      });
      setInvites((prev) => [res.invite, ...prev]);
      setInviteNote("");
      toast.success("Pozvánka vytvořena");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pozvánku se nepodařilo vytvořit");
    } finally {
      setCreatingInvite(false);
    }
  }

  async function revokeInvite(code: string) {
    if (!window.confirm("Zrušit tuhle pozvánku? Odkaz přestane fungovat.")) return;
    try {
      await api(`/api/invites/${code}`, { method: "DELETE" });
      setInvites((prev) => prev.map((inv) => (inv.code === code ? { ...inv, revoked: true, active: false } : inv)));
      toast.success("Pozvánka zrušena");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Pozvánku se nepodařilo zrušit");
    }
  }

  function inviteURL(code: string) {
    return `${getServer() || location.origin}/?invite=${code}`;
  }

  async function copyInvite(code: string) {
    try {
      await navigator.clipboard.writeText(inviteURL(code));
      toast.success("Odkaz zkopírován");
    } catch {
      toast.error("Kopírování se nepovedlo, zkopíruj kód ručně");
    }
  }

  function expiryLabel(invite: Invite) {
    if (invite.revoked) return "zrušená";
    if (invite.expiresAt) {
      const days = Math.ceil((invite.expiresAt - Date.now()) / 86_400_000);
      if (days <= 0) return "vypršela";
      return days === 1 ? "vyprší za den" : `vyprší za ${days} dní`;
    }
    return "bez expirace";
  }

  const patch = (value: Partial<UserSettings>) => setSettings((prev) => ({ ...prev, ...value }));

  const close = () => {
    applyTheme(user.settings);
    onClose();
  };

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Vyber obrázek (PNG, JPEG nebo GIF)");
      return;
    }
    if (file.size > 15 * 1024 * 1024) {
      setError("Obrázek je moc velký (max 15 MB)");
      return;
    }
    setAvatarBusy(true);
    setError("");
    try {
      const blob = await prepareAvatar(file);
      const updated = await uploadAvatar(blob);
      setAvatarId(updated.avatarId);
      await onRefreshUser();
      toast.success("Profilovka změněna");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Profilovku se nepodařilo nahrát");
    } finally {
      setAvatarBusy(false);
    }
  };

  const handleAvatarRemove = async () => {
    setAvatarBusy(true);
    setError("");
    try {
      const updated = await removeAvatar();
      setAvatarId(updated.avatarId);
      await onRefreshUser();
      toast.success("Profilovka odebrána");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Profilovku se nepodařilo odebrat");
    } finally {
      setAvatarBusy(false);
    }
  };

  const clearUserTimeout = async (target: User) => {
    setBusyUser(target.id);
    try {
      const res = await api<{ user: User }>(`/api/users/${target.id}/timeout`, { method: "DELETE" });
      setUsers((prev) => prev.map((u) => (u.id === res.user.id ? res.user : u)));
      toast.success(`Timeout pro ${res.user.displayName} zrušen`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Timeout se nepodařilo zrušit");
    } finally {
      setBusyUser(null);
    }
  };

  const save = async () => {
    if (!validColor(avatarColor)) {
      setError("Neplatná barva profilu");
      return;
    }
    if (displayName.trim().length === 0) {
      setError("Zobrazované jméno nesmí být prázdné");
      return;
    }
    const site = normalizeWebsite(website);
    if (site.length > 160) {
      setError("Odkaz je moc dlouhý (max 160 znaků)");
      return;
    }
    setSaving(true);
    setError("");
    setWebsite(site);
    try {
      await onSave({
        displayName: displayName.trim(),
        bio: bio.trim(),
        avatarColor,
        statusEmoji: statusEmoji.trim(),
        statusText: statusText.trim(),
        pronouns: pronouns.trim(),
        location: place.trim(),
        website: site,
        settings,
      });
      toast.success("Nastavení uloženo");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Uložení selhalo");
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    if (newPassword.length < 6) {
      toast.error("Nové heslo musí mít alespoň 6 znaků");
      return;
    }
    setChangingPassword(true);
    try {
      await api("/api/me/password", {
        method: "POST",
        body: { current: currentPassword, new: newPassword },
      });
      toast.success("Heslo změněno");
      setCurrentPassword("");
      setNewPassword("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Heslo se nepodařilo změnit");
    } finally {
      setChangingPassword(false);
    }
  };

  const toggleNotifications = async (checked: boolean) => {
    if (checked && "Notification" in window && Notification.permission === "default") {
      const result = await Notification.requestPermission();
      if (result !== "granted") toast.info("Notifikace zůstaly zakázané v prohlížeči");
    }
    patch({ notifications: checked });
  };

  const saveServer = () => {
    setServer(serverValue);
    location.reload();
  };

  const resetSettings = () => {
    if (!window.confirm("Vrátit vzhled a chování chatu do výchozího nastavení?")) return;
    setSettings({
      theme: "dark",
      accent: "#5865f2",
      density: "cozy",
      fontScale: 1,
      showErrors: true,
      showTimestamps: true,
      enterToSend: true,
      notifications: true,
      presence: "everyone",
      messageSound: true,
      soundStyle: "chime",
      soundVolume: 0.6,
      callSounds: true,
      bubbleStyle: "rounded",
    });
  };

  const filteredUsers = users.filter((member) => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return true;
    return member.username.toLowerCase().includes(q) || member.displayName.toLowerCase().includes(q);
  });

  return (
    <>
      <Modal
      open={open}
      onClose={close}
      wide
      title="Nastavení"
      subtitle="Vzhled, soukromí, chování chatu a diagnostika"
      footer={
        tab === "users" || tab === "invites" || tab === "system" ? (
          <button className="btn ghost" onClick={close}>
            Zavřít
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={close}>
              Zrušit
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={saving}>
              {saving ? <Spinner size={16} /> : <Icon name="check" size={16} />} Uložit změny
            </button>
          </>
        )
      }
    >
      <div className="settingsLayout">
        <nav className="settingsNav">
          {TABS.filter((item) => !item.admin || user.admin).map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? "active" : ""}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={17} /> {item.label}
            </button>
          ))}
        </nav>

        <div className="settingsContent">
          {error && <div className="formError">{error}</div>}

          {tab === "profile" && (
            <div className="settingsSection">
              <div className="profilePreview avatarEditor">
                <Avatar
                  name={displayName || user.username}
                  color={avatarColor}
                  avatarId={avatarId}
                  size={76}
                />
                <div className="avatarEditorText">
                  <strong>{displayName || user.username}</strong>
                  <span>@{user.username}</span>
                  {user.admin && <span className="adminTag">admin</span>}
                  {(statusEmoji.trim() || statusText.trim()) && (
                    <span className="previewStatus">
                      {statusEmoji.trim()} {statusText.trim()}
                    </span>
                  )}
                  <div className="avatarEditorActions">
                    <label className={`btn tiny${avatarBusy ? " disabled" : ""}`}>
                      {avatarBusy ? <Spinner size={13} /> : <Icon name="image" size={14} />} Nahrát fotku
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/gif,image/webp"
                        hidden
                        onChange={(event) => void handleAvatarFile(event.target.files?.[0])}
                        disabled={avatarBusy}
                      />
                    </label>
                    {avatarId && (
                      <button
                        type="button"
                        className="btn tiny danger ghost"
                        onClick={() => void handleAvatarRemove()}
                        disabled={avatarBusy}
                      >
                        Odebrat
                      </button>
                    )}
                  </div>
                  <small className="muted">Čtverec se ořízne automaticky, max 15 MB.</small>
                </div>
              </div>

              <div className="statusFields">
                <label className="field statusEmojiField">
                  <span>Stavové emoji</span>
                  <input
                    value={statusEmoji}
                    onChange={(e) => setStatusEmoji(e.target.value)}
                    maxLength={8}
                    placeholder="😀"
                  />
                </label>
                <label className="field">
                  <span>Vlastní stav</span>
                  <input
                    value={statusText}
                    onChange={(e) => setStatusText(e.target.value)}
                    maxLength={60}
                    placeholder="Co zrovna děláš?"
                  />
                  <small>{statusText.length}/60</small>
                </label>
              </div>

              <label className="field">
                <span>Zobrazované jméno</span>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={40} />
              </label>
              <label className="field">
                <span>O mně</span>
                <textarea
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  rows={3}
                  maxLength={300}
                  placeholder="Něco krátkého o tobě…"
                />
              </label>

              <div className="formGrid">
                <label className="field">
                  <span>Zájmena</span>
                  <input
                    value={pronouns}
                    onChange={(e) => setPronouns(e.target.value)}
                    maxLength={24}
                    placeholder="on / ona / oni"
                  />
                </label>
                <label className="field">
                  <span>Lokalita</span>
                  <input
                    value={place}
                    onChange={(e) => setPlace(e.target.value)}
                    maxLength={48}
                    placeholder="Praha"
                  />
                </label>
              </div>

              <label className="field">
                <span>Web nebo odkaz</span>
                <input
                  value={website}
                  onChange={(e) => {
                    setWebsite(e.target.value);
                    if (error) setError("");
                  }}
                  maxLength={160}
                  placeholder="https://…"
                  spellCheck={false}
                />
                <small>Když vynecháš https://, doplníme ho automaticky.</small>
              </label>

              <div className="field">
                <span>Barva profilu</span>
                <div className="colorRow">
                  {COLOR_CHOICES.map((color) => (
                    <button
                      key={color}
                      type="button"
                      className={`colorSwatch${avatarColor === color ? " active" : ""}`}
                      style={{ background: color }}
                      onClick={() => setAvatarColor(color)}
                      aria-label={`Barva ${color}`}
                    />
                  ))}
                  <input
                    type="color"
                    value={avatarColor}
                    onChange={(e) => setAvatarColor(e.target.value)}
                    title="Vlastní barva"
                  />
                </div>
              </div>

              <div className="settingsBlock">
                <h4>
                  <Icon name="key" size={16} /> Změna hesla
                </h4>
                <div className="formGrid">
                  <label className="field">
                    <span>Současné heslo</span>
                    <input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                    />
                  </label>
                  <label className="field">
                    <span>Nové heslo</span>
                    <input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <button
                  className="btn tiny"
                  onClick={() => void changePassword()}
                  disabled={changingPassword || !currentPassword || !newPassword}
                >
                  {changingPassword ? <Spinner size={14} /> : <Icon name="key" size={14} />} Změnit heslo
                </button>
              </div>
            </div>
          )}

          {tab === "appearance" && (
            <div className="settingsSection">
              <div className="settingsBlock">
                <h4>
                  <Icon name="palette" size={16} /> Motiv
                </h4>
                <div className="themeCards">
                  {(
                    [
                      { id: "dark", label: "Tmavý", icon: "moon" },
                      { id: "light", label: "Světlý", icon: "sun" },
                      { id: "system", label: "Podle systému", icon: "settings" },
                    ] as const
                  ).map((item) => (
                    <button
                      key={item.id}
                      className={`themeCard theme-${item.id}${settings.theme === item.id ? " active" : ""}`}
                      onClick={() => patch({ theme: item.id })}
                    >
                      <span className="themePreview">
                        <span />
                        <span />
                      </span>
                      <span>
                        <Icon name={item.icon} size={15} /> {item.label}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="settingsBlock">
                <h4>Akcentní barva</h4>
                <div className="colorRow">
                  {ACCENTS.map((color) => (
                    <button
                      key={color}
                      className={`colorSwatch${settings.accent === color ? " active" : ""}`}
                      style={{ background: color }}
                      onClick={() => patch({ accent: color })}
                      aria-label={`Akcent ${color}`}
                    />
                  ))}
                  <input
                    type="color"
                    value={settings.accent}
                    onChange={(e) => patch({ accent: e.target.value })}
                    title="Vlastní akcent"
                  />
                </div>
              </div>

              <div className="settingsBlock">
                <h4>Rozložení</h4>
                <div className="segmented compactSegments">
                  <button
                    className={settings.density === "cozy" ? "active" : ""}
                    onClick={() => patch({ density: "cozy" })}
                  >
                    <span>
                      <strong>Pohodlné</strong>
                      <small>větší mezery</small>
                    </span>
                  </button>
                  <button
                    className={settings.density === "compact" ? "active" : ""}
                    onClick={() => patch({ density: "compact" })}
                  >
                    <span>
                      <strong>Kompaktní</strong>
                      <small>víc zpráv na obrazovce</small>
                    </span>
                  </button>
                </div>
              </div>

              <label className="field">
                <span>Velikost textu · {Math.round(settings.fontScale * 100)} %</span>
                <input
                  type="range"
                  min={0.85}
                  max={1.3}
                  step={0.05}
                  value={settings.fontScale}
                  onChange={(e) => patch({ fontScale: Number(e.target.value) })}
                />
              </label>
            </div>
          )}

          {tab === "chat" && (
            <div className="settingsSection">
              <div className="toggleRows">
                <label className="toggleRow">
                  <span>
                    <strong>Odesílat Enterem</strong>
                    <small>Shift+Enter udělá nový řádek</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.enterToSend}
                    onChange={(e) => patch({ enterToSend: e.target.checked })}
                  />
                </label>
                <label className="toggleRow">
                  <span>
                    <strong>Časy u zpráv</strong>
                    <small>Ukazovat hodinu odeslání</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.showTimestamps}
                    onChange={(e) => patch({ showTimestamps: e.target.checked })}
                  />
                </label>
                <label className="toggleRow">
                  <span>
                    <strong>Zvuk nové zprávy</strong>
                    <small>Jemné pípnutí při zprávě v jiném kanálu</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.messageSound}
                    onChange={(e) => patch({ messageSound: e.target.checked })}
                  />
                </label>
                <label className="toggleRow">
                  <span>
                    <strong>Zvuky hovorů</strong>
                    <small>Zvonění při příchozím hovoru a tón při připojení</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.callSounds}
                    onChange={(e) => patch({ callSounds: e.target.checked })}
                  />
                </label>
                <label className="toggleRow">
                  <span>
                    <strong>Notifikace</strong>
                    <small>Systémové oznámení, když je chat na pozadí</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.notifications}
                    onChange={(e) => void toggleNotifications(e.target.checked)}
                  />
                </label>
                <label className="toggleRow">
                  <span>
                    <strong>Zobrazovat chyby</strong>
                    <small>Toasty a chybové hlášky v rozhraní</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.showErrors}
                    onChange={(e) => patch({ showErrors: e.target.checked })}
                  />
                </label>
              </div>
              <div className="settingsBlock">
                <h4>
                  <Icon name="bell" size={16} /> Zvuk oznámení
                </h4>
                <div className="soundChoices">
                  {(
                    [
                      { id: "chime", label: "Chime" },
                      { id: "pop", label: "Pop" },
                      { id: "blip", label: "Blip" },
                      { id: "bell", label: "Bell" },
                    ] as const
                  ).map((sound) => (
                    <button
                      key={sound.id}
                      type="button"
                      className={`soundChoice${settings.soundStyle === sound.id ? " active" : ""}`}
                      onClick={() => {
                        patch({ soundStyle: sound.id });
                        playPing({ soundStyle: sound.id, soundVolume: settings.soundVolume });
                      }}
                    >
                      {sound.label}
                    </button>
                  ))}
                </div>
                <label className="field">
                  <span>Hlasitost · {Math.round(settings.soundVolume * 100)} %</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={settings.soundVolume}
                    onChange={(e) => patch({ soundVolume: Number(e.target.value) })}
                    onMouseUp={() =>
                      playPing({ soundStyle: settings.soundStyle, soundVolume: settings.soundVolume })
                    }
                  />
                </label>
              </div>

              <p className="hintBox">
                <Icon name="info" size={15} /> Když chyby vypneš, dál se ukládají do logu v záložce Systém.
              </p>
            </div>
          )}

          {tab === "privacy" && (
            <div className="settingsSection">
              <div className="settingsBlock">
                <h4>
                  <Icon name="eye" size={16} /> Viditelnost aktivity
                </h4>
                <p className="muted">
                  Ostatní uvidí u tvého jména zelenou tečku, když jsi online. Můžeš to schovat.
                </p>
                <div className="segmented compactSegments">
                  <button
                    className={settings.presence === "everyone" ? "active" : ""}
                    onClick={() => patch({ presence: "everyone" })}
                  >
                    <span>
                      <strong>Všichni</strong>
                      <small>ukazovat moje online</small>
                    </span>
                  </button>
                  <button
                    className={settings.presence === "nobody" ? "active" : ""}
                    onClick={() => patch({ presence: "nobody" })}
                  >
                    <span>
                      <strong>Nikdo</strong>
                      <small>vždy offline</small>
                    </span>
                  </button>
                </div>
              </div>
              <div className="hintBox">
                <Icon name="shield" size={15} /> Kanály, zprávy a soubory jsou dostupné jen členům daného
                kanálu. Soukromé kanály neuvidí ani ve výpisu.
              </div>
            </div>
          )}

          {tab === "users" && user.admin && (
            <div className="settingsSection">
              <div className="settingsBlock">
                <div className="row spaceBetween">
                  <h4>
                    <Icon name="users" size={16} /> Uživatelé ({users.length})
                  </h4>
                  <div className="userSearch">
                    <Icon name="search" size={14} />
                    <input
                      value={userQuery}
                      onChange={(e) => setUserQuery(e.target.value)}
                      placeholder="Hledat uživatele…"
                      aria-label="Hledat uživatele"
                    />
                  </div>
                </div>
                <p className="muted">
                  Admin může spravovat kanály, mazat cizí zprávy, vytvářet pozvánky a udělovat bany.
                  Ban okamžitě odhlásí všechny relace daného účtu.
                </p>
                {usersLoading && (
                  <div className="row gap muted small">
                    <Spinner size={16} /> Načítám uživatele…
                  </div>
                )}
                <div className="adminUserList">
                  {filteredUsers.map((member) => (
                    <div className={`adminUserRow${member.banned ? " banned" : ""}`} key={member.id}>
                      <Avatar
                        name={member.displayName}
                        color={member.avatarColor}
                        avatarId={member.avatarId}
                        size={36}
                      />
                      <span className="adminUserInfo">
                        <strong>
                          {member.displayName}
                          {member.id === user.id && " (ty)"}
                        </strong>
                        <small>@{member.username}</small>
                        {(member.statusEmoji || member.statusText) && (
                          <small className="memberStatus">
                            {member.statusEmoji} {member.statusText}
                          </small>
                        )}
                        {member.banned && (
                          <small className="banReasonText">
                            ban {member.bannedUntil ? `do ${formatDateTime(member.bannedUntil)}` : "trvale"}
                            {member.banReason ? ` · ${member.banReason}` : ""}
                          </small>
                        )}
                        {member.timeoutUntil && member.timeoutUntil > Date.now() && (
                          <small className="timeoutReasonText">
                            timeout do {formatDateTime(member.timeoutUntil)}
                            {member.timeoutReason ? ` · ${member.timeoutReason}` : ""}
                          </small>
                        )}
                      </span>
                      {member.admin && <span className="adminTag">admin</span>}
                      {member.banned && <span className="banTag">ban</span>}
                      {member.timeoutUntil && member.timeoutUntil > Date.now() && (
                        <span className="timeoutTag">timeout</span>
                      )}
                      <div className="adminUserActions">
                        {member.id !== user.id && (
                          <button
                            className={`btn tiny${member.admin ? " danger ghost" : ""}`}
                            onClick={() => void toggleAdmin(member)}
                            disabled={busyUser === member.id}
                          >
                            {busyUser === member.id ? (
                              <Spinner size={14} />
                            ) : (
                              <Icon name={member.admin ? "userMinus" : "userPlus"} size={14} />
                            )}
                            {member.admin ? "Odebrat admina" : "Udělat adminem"}
                          </button>
                        )}
                        {member.id !== user.id && !member.admin && (
                          <button
                            className="btn tiny danger ghost"
                            onClick={() => {
                              if (member.timeoutUntil && member.timeoutUntil > Date.now()) {
                                void clearUserTimeout(member);
                              } else {
                                setTimeoutTarget(member);
                              }
                            }}
                            disabled={busyUser === member.id}
                            title={member.timeoutUntil && member.timeoutUntil > Date.now() ? "Zrušit timeout" : "Dočasně umlčet"}
                          >
                            <Icon name="clock" size={14} />{" "}
                            {member.timeoutUntil && member.timeoutUntil > Date.now() ? "Zrušit T" : "Timeout"}
                          </button>
                        )}
                        {member.id !== user.id &&
                          (member.banned ? (
                            <button
                              className="btn tiny"
                              onClick={() => void unbanUser(member)}
                              disabled={busyUser === member.id}
                            >
                              <Icon name="check" size={14} /> Odbanovat
                            </button>
                          ) : (
                            <button
                              className="btn tiny danger ghost"
                              onClick={() => setBanTarget(member)}
                              disabled={busyUser === member.id || member.admin}
                              title={member.admin ? "Admina nejde zabanovat" : "Zabanovat účet"}
                            >
                              <Icon name="ban" size={14} /> Ban
                            </button>
                          ))}
                      </div>
                    </div>
                  ))}
                  {!usersLoading && filteredUsers.length === 0 && (
                    <p className="muted small">Nikdo takový tu není.</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {tab === "invites" && user.admin && (
            <div className="settingsSection">
              <div className="settingsBlock">
                <h4>
                  <Icon name="link" size={16} /> Nová pozvánka
                </h4>
                <p className="muted">
                  Registrace je jen na jednorázovou pozvánku. Vygeneruj odkaz a pošli ho člověku, kterého
                  chceš přidat.
                </p>
                <div className="inviteForm">
                  <label className="field inviteNote">
                    <span>Poznámka</span>
                    <input
                      value={inviteNote}
                      onChange={(e) => setInviteNote(e.target.value)}
                      placeholder="Pro koho (nepovinné)"
                      maxLength={80}
                    />
                  </label>
                  <label className="field">
                    <span>Použití</span>
                    <input
                      type="number"
                      min={1}
                      max={100}
                      value={inviteUses}
                      onChange={(e) => setInviteUses(Math.max(1, Math.min(100, Number(e.target.value) || 1)))}
                    />
                  </label>
                  <label className="field">
                    <span>Platnost</span>
                    <select value={inviteExpiry} onChange={(e) => setInviteExpiry(Number(e.target.value))}>
                      <option value={0}>Bez omezení</option>
                      <option value={24}>24 hodin</option>
                      <option value={24 * 7}>7 dní</option>
                      <option value={24 * 30}>30 dní</option>
                    </select>
                  </label>
                  <button className="btn primary" onClick={() => void createInvite()} disabled={creatingInvite}>
                    {creatingInvite ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Vytvořit
                  </button>
                </div>
              </div>

              <div className="settingsBlock">
                <div className="row spaceBetween">
                  <h4>Vytvořené pozvánky</h4>
                  <button className="btn tiny ghost" onClick={() => void loadInvites()}>
                    <Icon name="refresh" size={13} /> Obnovit
                  </button>
                </div>
                {invitesLoading && (
                  <div className="row gap muted small">
                    <Spinner size={16} /> Načítám pozvánky…
                  </div>
                )}
                {!invitesLoading && invites.length === 0 && (
                  <p className="muted small">Zatím žádné pozvánky. Vytvoř první výše.</p>
                )}
                <div className="inviteList">
                  {invites.map((invite) => (
                    <div className={`inviteRow${invite.active ? "" : " inactive"}`} key={invite.code}>
                      <span className="inviteInfo">
                        <strong>{invite.note || "Pozvánka"}</strong>
                        <small>
                          <code>{invite.code}</code> · {invite.uses}/{invite.maxUses} použití ·{" "}
                          {expiryLabel(invite)}
                          {invite.expiresAt ? ` (${formatDateTime(invite.expiresAt)})` : ""}
                        </small>
                      </span>
                      <span className={`inviteStatus${invite.active ? " active" : ""}`}>
                        {invite.active ? "platná" : "neplatná"}
                      </span>
                      <button
                        className="btn tiny"
                        onClick={() => void copyInvite(invite.code)}
                        disabled={!invite.active}
                        title={inviteURL(invite.code)}
                      >
                        <Icon name="copy" size={14} /> Kopírovat odkaz
                      </button>
                      <button
                        className="btn tiny danger ghost"
                        onClick={() => void revokeInvite(invite.code)}
                        disabled={!invite.active}
                      >
                        <Icon name="x" size={14} /> Zrušit
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === "system" && (
            <div className="settingsSection">
              <div className="infoGrid">
                <div className="infoCard">
                  <span>Připojení</span>
                  <strong className={`statusText ${wsStatus}`}>
                    <span className={`dot ${wsStatus}`} />
                    {wsStatus === "online" ? "online" : wsStatus === "connecting" ? "připojuji" : "offline"}
                  </strong>
                </div>
                <div className="infoCard">
                  <span>Verze</span>
                  <strong>{version}</strong>
                </div>
                <div className="infoCard">
                  <span>Limit souboru</span>
                  <strong>{maxUploadMB} MB</strong>
                </div>
                <div className="infoCard">
                  <span>Účet</span>
                  <strong>{user.admin ? "admin" : "člen"}</strong>
                </div>
              </div>

              <div className="settingsBlock">
                <h4>
                  <Icon name="server" size={16} /> Server
                </h4>
                <div className="row gap">
                  <input
                    className="grow"
                    value={serverValue}
                    onChange={(e) => setServerValue(e.target.value)}
                    placeholder="https://melvin.example.com"
                    spellCheck={false}
                  />
                  <button className="btn tiny" onClick={saveServer}>
                    <Icon name="refresh" size={14} /> Připojit
                  </button>
                </div>
                <small className="muted">
                  Prázdné = stejný server, odkud je stránka načtená. V aplikaci zadej adresu svého serveru.
                </small>
              </div>

              <div className="settingsBlock">
                <div className="row spaceBetween">
                  <h4>
                    <Icon name="alert" size={16} /> Log chyb ({logs.length})
                  </h4>
                  <div className="row gap">
                    <button className="btn tiny ghost" onClick={() => setLogs(getLogs())}>
                      <Icon name="refresh" size={13} /> Obnovit
                    </button>
                    <button className="btn tiny ghost" onClick={downloadLogs}>
                      <Icon name="download" size={13} /> Stáhnout
                    </button>
                    <button
                      className="btn tiny ghost"
                      onClick={() => {
                        clearLogs();
                        setLogs([]);
                      }}
                    >
                      Vymazat
                    </button>
                  </div>
                </div>
                <div className="logList">
                  {logs.length === 0 && <p className="muted small">Žádné chyby. To je dobré znamení.</p>}
                  {logs
                    .slice()
                    .reverse()
                    .map((entry, index) => (
                      <div className={`logRow log-${entry.level}`} key={`${entry.time}-${index}`}>
                        <time>{formatDateTime(entry.time)}</time>
                        <strong>{entry.message}</strong>
                        {entry.detail && <pre>{entry.detail}</pre>}
                      </div>
                    ))}
                </div>
              </div>

              <div className="settingsBlock">
                <div className="row spaceBetween">
                  <button className="btn tiny ghost danger" onClick={resetSettings}>
                    <Icon name="refresh" size={14} /> Výchozí nastavení
                  </button>
                  <button className="btn danger" onClick={onLogout}>
                    <Icon name="logOut" size={16} /> Odhlásit se
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      </Modal>
      {banTarget && (
        <BanModal
          user={banTarget}
          onClose={() => setBanTarget(null)}
          onBanned={(updated) => {
            setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
            setBanTarget(null);
          }}
        />
      )}
      {timeoutTarget && (
        <TimeoutModal
          user={timeoutTarget}
          onClose={() => setTimeoutTarget(null)}
          onDone={(updated) => {
            setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
            setTimeoutTarget(null);
          }}
        />
      )}
    </>
  );
}
