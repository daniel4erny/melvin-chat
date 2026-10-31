import type { AppConfig, Attachment, AttachmentKind, User } from "./types";

const TOKEN_KEY = "melvin.token";
const SERVER_KEY = "melvin.server";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorizedHandler = fn;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getServer(): string {
  return localStorage.getItem(SERVER_KEY) ?? "";
}

export function setServer(server: string) {
  let clean = server.trim().replace(/\/+$/, "");
  if (clean && !/^https?:\/\//i.test(clean)) clean = `https://${clean}`;
  if (clean) localStorage.setItem(SERVER_KEY, clean);
  else localStorage.removeItem(SERVER_KEY);
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Absolute URL for the API. Empty server means same origin (web deployment). */
export function apiURL(path: string): string {
  return getServer() + path;
}

export function wsURL(): string {
  const token = getToken() ?? "";
  const server = getServer();
  const base = server
    ? server.replace(/^http/i, "ws")
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base}/ws?token=${encodeURIComponent(token)}`;
}

export function fileURL(id: string): string {
  return `${apiURL(`/api/files/${id}`)}?token=${encodeURIComponent(getToken() ?? "")}`;
}

// Avatars are served by an unguessable random id and need no token, so plain
// <img> tags can load them without custom headers.
export function avatarURL(id: string): string {
  return apiURL(`/api/avatars/${id}`);
}

export async function uploadAvatar(blob: Blob): Promise<User> {
  const headers: Record<string, string> = { "Content-Type": blob.type || "image/png" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(apiURL("/api/me/avatar"), { method: "POST", headers, body: blob });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Nahrání obrázku selhalo (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return (data as { user: User }).user;
}

export async function removeAvatar(): Promise<User> {
  const res = await api<{ user: User }>("/api/me/avatar", { method: "DELETE" });
  return res.user;
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
};

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetch(apiURL(path), {
      method: opts.method ?? (body ? "POST" : "GET"),
      headers,
      body,
      signal: opts.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiError(0, "Server je nedostupný. Zkontroluj připojení nebo adresu serveru.");
  }
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `Chyba ${res.status}`;
    const banned = res.status === 403 && /zabanovan/i.test(message);
    if (
      (res.status === 401 || banned) &&
      !path.startsWith("/api/auth/login") &&
      !path.startsWith("/api/auth/register")
    ) {
      unauthorizedHandler?.();
    }
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export async function fetchConfig(): Promise<AppConfig> {
  return api<AppConfig>("/api/config");
}

export function kindFromFile(file: File): AttachmentKind {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

function putChunk(
  url: string,
  blob: Blob,
  onProgress: (loaded: number) => void,
  signal?: AbortSignal,
): Promise<{ received: number }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    const token = getToken();
    if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText || "{}");
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as { received: number });
        else reject(new ApiError(xhr.status, data.error ?? `Chyba ${xhr.status}`));
      } catch {
        reject(new ApiError(xhr.status, `Chyba ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Nahrávání selhalo – zkontroluj připojení"));
    xhr.onabort = () => reject(new DOMException("Aborted", "AbortError"));
    if (signal) {
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }
    xhr.send(blob);
  });
}

export async function uploadBlob(
  blob: Blob,
  name: string,
  kind: AttachmentKind,
  duration: number,
  onProgress: (uploaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<Attachment> {
  const init = await api<{ id: string; chunkSize: number; maxSize: number }>("/api/uploads/init", {
    method: "POST",
    body: { name, size: blob.size, mime: blob.type, kind, duration },
    signal,
  });
  const chunkSize = init.chunkSize;
  let offset = 0;
  while (offset < blob.size) {
    const end = Math.min(offset + chunkSize, blob.size);
    const chunk = blob.slice(offset, end);
    const res = await putChunk(
      apiURL(`/api/uploads/${init.id}/chunk?offset=${offset}`),
      chunk,
      (loaded) => onProgress(offset + loaded, blob.size),
      signal,
    );
    offset = res.received;
  }
  const done = await api<{ attachment: Attachment }>(`/api/uploads/${init.id}/complete`, {
    method: "POST",
    body: {},
    signal,
  });
  onProgress(blob.size, blob.size);
  return done.attachment;
}

export function setMeCache(user: User | null) {
  if (user) localStorage.setItem("melvin.me", JSON.stringify(user));
  else localStorage.removeItem("melvin.me");
}

export function getMeCache(): User | null {
  try {
    const raw = localStorage.getItem("melvin.me");
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}
