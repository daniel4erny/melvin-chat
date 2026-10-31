import { Component, useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { initials } from "../utils";
import { logEvent } from "../logs";
import { Icon } from "./Icon";

export function Avatar({
  name,
  color,
  size = 36,
  online,
  onClick,
}: {
  name: string;
  color: string;
  size?: number;
  online?: boolean;
  onClick?: () => void;
}) {
  return (
    <span
      className={`avatar${onClick ? " avatarButton" : ""}`}
      style={{ width: size, height: size, background: color, fontSize: Math.round(size * 0.36) }}
      onClick={onClick}
      title={name}
    >
      {initials(name)}
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
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
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
      <div className={`modalCard${wide ? " modalWide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modalHead">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="iconBtn" onClick={onClose} aria-label="Zavřít">
            <Icon name="x" size={20} />
          </button>
        </header>
        <div className="modalBody">{children}</div>
        {footer && <footer className="modalFoot">{footer}</footer>}
      </div>
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
