import { useEffect, useState } from "react";
import { api, getServer, setServer } from "../api";
import { applyTheme } from "../theme";
import { toast } from "../toast";
import { clearLogs, downloadLogs, getLogs, type LogEntry } from "../logs";
import type { User, UserSettings, WSStatus } from "../types";
import { formatDateTime, validColor } from "../utils";
import { Icon, type IconName } from "./Icon";
import { Avatar, Modal, Spinner } from "./ui";

const ACCENTS = ["#5865f2", "#1abc9c", "#eb459e", "#f0b232", "#3ba55c", "#ed4245", "#00a8fc", "#a78bfa"];
const COLOR_CHOICES = ["#5865f2", "#1abc9c", "#eb459e", "#f0b232", "#3ba55c", "#ed4245", "#00a8fc", "#a78bfa", "#94a3b8"];

type Tab = "profile" | "appearance" | "chat" | "privacy" | "system";

const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "profile", label: "Profil", icon: "user" },
  { id: "appearance", label: "Vzhled", icon: "palette" },
  { id: "chat", label: "Chat", icon: "bell" },
  { id: "privacy", label: "Soukromí", icon: "shield" },
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
}: {
  open: boolean;
  onClose: () => void;
  user: User;
  wsStatus: WSStatus;
  version: string;
  maxUploadMB: number;
  onSave: (patch: Record<string, unknown>) => Promise<User>;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<Tab>("profile");
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio);
  const [avatarColor, setAvatarColor] = useState(user.avatarColor);
  const [settings, setSettings] = useState<UserSettings>(user.settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [changingPassword, setChangingPassword] = useState(false);

  const [serverValue, setServerValue] = useState(getServer());
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!open) return;
    setDisplayName(user.displayName);
    setBio(user.bio);
    setAvatarColor(user.avatarColor);
    setSettings(user.settings);
    setError("");
    setTab("profile");
    setCurrentPassword("");
    setNewPassword("");
    setServerValue(getServer());
  }, [open, user]);

  useEffect(() => {
    if (open) applyTheme(settings);
  }, [settings, open]);

  useEffect(() => {
    if (open && tab === "system") setLogs(getLogs());
  }, [open, tab]);

  const patch = (value: Partial<UserSettings>) => setSettings((prev) => ({ ...prev, ...value }));

  const close = () => {
    applyTheme(user.settings);
    onClose();
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
    setSaving(true);
    setError("");
    try {
      await onSave({
        displayName: displayName.trim(),
        bio: bio.trim(),
        avatarColor,
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
      bubbleStyle: "rounded",
    });
  };

  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title="Nastavení"
      subtitle="Vzhled, soukromí, chování chatu a diagnostika"
      footer={
        <>
          <button className="btn ghost" onClick={close}>
            Zrušit
          </button>
          <button className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Spinner size={16} /> : <Icon name="check" size={16} />} Uložit změny
          </button>
        </>
      }
    >
      <div className="settingsLayout">
        <nav className="settingsNav">
          {TABS.map((item) => (
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
              <div className="profilePreview">
                <Avatar name={displayName || user.username} color={avatarColor} size={64} />
                <div>
                  <strong>{displayName || user.username}</strong>
                  <span>@{user.username}</span>
                  {user.admin && <span className="adminTag">admin</span>}
                </div>
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
  );
}
