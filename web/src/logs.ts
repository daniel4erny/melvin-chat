export type LogEntry = {
  time: number;
  level: "error" | "warn" | "info";
  message: string;
  detail?: string;
};

const entries: LogEntry[] = [];
const MAX_ENTRIES = 200;

export function logEvent(level: LogEntry["level"], message: string, detail?: unknown) {
  let rendered: string | undefined;
  if (detail !== undefined) {
    rendered = detail instanceof Error ? `${detail.name}: ${detail.message}\n${detail.stack ?? ""}` : String(detail);
  }
  entries.push({ time: Date.now(), level, message, detail: rendered });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
}

export function getLogs(): LogEntry[] {
  return [...entries];
}

export function clearLogs() {
  entries.length = 0;
}

export function installGlobalLogging() {
  window.addEventListener("error", (event) => {
    logEvent("error", "Neočekávaná chyba", event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    logEvent("error", "Neošetřený promise", event.reason);
  });
}

export function downloadLogs() {
  const lines = entries.map(
    (e) => `[${new Date(e.time).toISOString()}] ${e.level.toUpperCase()} ${e.message}${e.detail ? `\n${e.detail}` : ""}`,
  );
  const blob = new Blob([lines.join("\n\n") || "Žádné záznamy."], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `melvin-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}
