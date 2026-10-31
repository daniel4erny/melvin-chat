import type { UserSettings } from "./types";

let current: UserSettings | null = null;
let watcherInstalled = false;

function readableInk(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return "#04121a";
  const value = parseInt(m[1]!, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.62 ? "#07131c" : "#ffffff";
}

export function applyTheme(settings: UserSettings) {
  current = settings;
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolved = settings.theme === "system" ? (systemDark ? "dark" : "light") : settings.theme;
  root.dataset.theme = resolved;
  root.dataset.density = settings.density;
  root.dataset.bubbles = settings.bubbleStyle;
  root.style.setProperty("--accent", settings.accent);
  root.style.setProperty("--accent-ink", readableInk(settings.accent));
  root.style.setProperty("--font-scale", String(settings.fontScale));
  root.style.colorScheme = resolved;
  if (!watcherInstalled) {
    watcherInstalled = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (current) applyTheme(current);
    });
  }
}

export function resolvedTheme(settings: UserSettings): "dark" | "light" {
  if (settings.theme !== "system") return settings.theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
