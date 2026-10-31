import { Component, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { avatarURL } from "../api";
import { initials } from "../utils";
import { logEvent } from "../logs";
import { Icon } from "./Icon";

function avatarInk(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return "#ffffff";
  const value = parseInt(match[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? "#15171c" : "#ffffff";
}

export function Avatar({
  name,
  color,
  avatarId,
  size = 36,
  online,
  onClick,
  ring,
}: {
  name: string;
  color: string;
  avatarId?: string;
  size?: number;
  online?: boolean;
  onClick?: () => void;
  ring?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [avatarId]);
  const showPhoto = Boolean(avatarId) && !failed;
  return (
    <span
      className={`avatar${onClick ? " avatarButton" : ""}${showPhoto ? " hasPhoto" : ""}${ring ? " avatarRing" : ""}`}
      style={{
        width: size,
        height: size,
        background: color,
        color: avatarInk(color),
        fontSize: Math.round(size * 0.36),
      }}
      onClick={onClick}
      title={name}
    >
      {showPhoto ? (
        <img src={avatarURL(avatarId!)} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <span className="avatarInitials">{initials(name)}</span>
      )}
      {online !== undefined && <span className={`presenceDot${online ? " online" : ""}`} />}
    </span>
  );
}

export function Spinner({ size = 20 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  hideHead,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  hideHead?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="modalBackdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modalCard${wide ? " modalWide" : ""}${hideHead ? " modalBare" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {hideHead ? (
          <button className="iconBtn modalCloseFloat" onClick={onClose} aria-label="Zavřít">
            <Icon name="x" size={18} />
          </button>
        ) : (
          <header className="modalHead">
            <div>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <button className="iconBtn" onClick={onClose} aria-label="Zavřít">
              <Icon name="x" size={20} />
            </button>
          </header>
        )}
        <div className="modalBody">{children}</div>
        {footer && <footer className="modalFoot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  );
}

export function SidePanel({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div
      className="sidePanelBackdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="sidePanel" role="dialog" aria-modal="true" aria-label={typeof title === "string" ? title : "Panel"}>
        <header className="sidePanelHead">
          <div className="sidePanelTitle">
            <h3>{title}</h3>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="iconBtn" onClick={onClose} aria-label="Zavřít">
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="sidePanelBody">{children}</div>
        {footer && <footer className="sidePanelFoot">{footer}</footer>}
      </aside>
    </div>,
    document.body,
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    logEvent("error", "React crash", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="crashScreen">
          <div className="crashCard">
            <Icon name="alert" size={34} />
            <h1>Něco se pokazilo</h1>
            <p>{this.state.error.message}</p>
            <div className="row gap">
              <button className="btn" onClick={() => location.reload()}>
                <Icon name="refresh" /> Načíst znovu
              </button>
              <button className="btn ghost" onClick={() => this.setState({ error: null })}>
                Zkusit pokračovat
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
