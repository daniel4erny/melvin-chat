import { useEffect, useMemo, useState } from "react";
import { fetchConfig, getServer, isTauri, setServer } from "../api";
import { useAuth } from "../auth";
import { Icon } from "../components/Icon";
import { Spinner } from "../components/ui";
import { toast } from "../toast";
import type { AppConfig } from "../types";
import "../styles/auth.css";

export default function Login() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [invite, setInvite] = useState("");
  const [server, setServerValue] = useState(() => getServer());
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [config, setConfig] = useState<AppConfig | null>(null);

  const native = useMemo(() => isTauri() || new URLSearchParams(location.search).has("server"), []);

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch(() => setConfig(null));
  }, []);

  const normalizeServer = (value: string) => {
    let v = value.trim();
    if (!v) return "";
    if (!/^https?:\/\//i.test(v)) v = `https://${v}`;
    return v.replace(/\/+$/, "");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      const serverValue = native ? normalizeServer(server) : undefined;
      if (native && serverValue) setServer(serverValue);
      if (mode === "login") {
        await login(username.trim(), password, serverValue);
      } else {
        await register({
          username: username.trim(),
          password,
          displayName: displayName.trim(),
          invite: invite.trim(),
          server: serverValue,
        });
      }
      toast.success("Vítej v Melvinu!");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Přihlášení selhalo";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const switchMode = (next: "login" | "register") => {
    setMode(next);
    setError("");
  };

  return (
    <div className="authPage">
      <section className="authCard">
        <div className="authBrand">
          <span className="brandMark">M</span>
          <span className="brandName">Melvin</span>
        </div>

        <header className="authHead">
          <h1>{mode === "login" ? "Vítej zpět!" : "Vytvoř si účet"}</h1>
          <p>{mode === "login" ? "Jsme rádi, že tě zase vidíme." : "Přidej se k partě na svém serveru."}</p>
        </header>

        <form onSubmit={submit} className="authForm">
          {mode === "register" && (
            <label className="field">
              <span>Zobrazované jméno</span>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jak ti mají říkat"
                autoComplete="nickname"
                maxLength={40}
              />
            </label>
          )}

          <label className="field">
            <span>Uživatelské jméno</span>
            <div className="inputWrap">
              <Icon name="user" size={17} />
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="melvin"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                minLength={3}
                maxLength={24}
              />
            </div>
          </label>

          <label className="field">
            <span>Heslo</span>
            <div className="inputWrap">
              <Icon name="key" size={17} />
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={6}
              />
              <button
                type="button"
                className="inputAction"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Skrýt heslo" : "Zobrazit heslo"}
              >
                <Icon name={showPassword ? "eyeOff" : "eye"} size={17} />
              </button>
            </div>
          </label>

          {mode === "register" && config?.needsInvite && (
            <label className="field">
              <span>Pozvánkový kód</span>
              <div className="inputWrap">
                <Icon name="shield" size={17} />
                <input
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="Kód od správce"
                  autoComplete="off"
                  required
                />
              </div>
            </label>
          )}

          {native && (
            <label className="field">
              <span>Adresa serveru</span>
              <div className="inputWrap">
                <Icon name="server" size={17} />
                <input
                  value={server}
                  onChange={(e) => setServerValue(e.target.value)}
                  placeholder="https://melvin.example.com"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </div>
              <small>Adresa, kde běží Melvin API (bez lomítka na konci).</small>
            </label>
          )}

          {error && <div className="formError">{error}</div>}

          <button className="btn primary big" type="submit" disabled={submitting}>
            {submitting ? <Spinner size={18} /> : <Icon name={mode === "login" ? "logOut" : "plus"} size={18} />}
            {mode === "login" ? "Přihlásit se" : "Vytvořit účet"}
          </button>
        </form>

        <p className="authHint">
          {mode === "login" ? "Nemáš účet? " : "Už máš účet? "}
          <button type="button" className="linkBtn" onClick={() => switchMode(mode === "login" ? "register" : "login")}>
            {mode === "login" ? "Vytvoř si ho" : "Přihlas se"}
          </button>
        </p>
        {native && (
          <p className="authHint subtle">
            Aplikace pro iOS, Android, Windows i Linux. Připoj se k libovolnému Melvin serveru.
          </p>
        )}
      </section>

      <p className="authVersion">
        {config ? `Melvin ${config.version} · ${config.maxUploadMB} MB na soubor` : "Melvin"}
      </p>
    </div>
  );
}
