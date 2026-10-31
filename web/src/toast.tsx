import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export type ToastKind = "error" | "success" | "info";
export type ToastAction = { label: string; onClick: () => void };
type ToastItem = { id: number; kind: ToastKind; message: string; action?: ToastAction };

let pushFn: ((item: ToastItem) => void) | null = null;
let errorsEnabled = true;
let nextId = 1;

export function setErrorToasts(enabled: boolean) {
  errorsEnabled = enabled;
}

function show(kind: ToastKind, message: string, action?: ToastAction) {
  if (kind === "error" && !errorsEnabled) {
    console.error(message);
    return;
  }
  pushFn?.({ id: nextId++, kind, message, action });
}

export const toast = {
  error: (message: string, action?: ToastAction) => show("error", message, action),
  success: (message: string, action?: ToastAction) => show("success", message, action),
  info: (message: string, action?: ToastAction) => show("info", message, action),
};

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    pushFn = (item) => {
      setItems((prev) => [...prev.slice(-4), item]);
      const ttl = item.kind === "error" ? 8000 : 4500;
      window.setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== item.id));
      }, ttl);
    };
    return () => {
      pushFn = null;
    };
  }, []);

  const dismiss = (id: number) => setItems((prev) => prev.filter((t) => t.id !== id));

  return createPortal(
    <div className="toaster" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast toast-${item.kind}`}>
          <span className="toastDot" />
          <span className="toastText">{item.message}</span>
          {item.action && (
            <button
              className="toastAction"
              onClick={() => {
                item.action?.onClick();
                dismiss(item.id);
              }}
            >
              {item.action.label}
            </button>
          )}
          <button className="toastClose" onClick={() => dismiss(item.id)} aria-label="Zavřít">
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
