export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0]!.slice(0, 2) || "?").toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}. ${pad(d.getMonth() + 1)}. ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return "Dnes";
  if (same(d, yesterday)) return "Včera";
  return d.toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" });
}

export function sameDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${pad(s)}`;
}

export function cooldown(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return formatDuration(s);
}

export function relativeTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return "teď";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h`;
  return new Date(ms).toLocaleDateString("cs-CZ", { day: "numeric", month: "numeric" });
}

let audioCtx: AudioContext | null = null;

type SoundSettings = { soundStyle?: string; soundVolume?: number };

function tone(
  ctx: AudioContext,
  type: OscillatorType,
  from: number,
  to: number,
  duration: number,
  volume: number,
  delay = 0,
) {
  const start = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(from, start);
  osc.frequency.exponentialRampToValueAtTime(Math.max(40, to), start + duration * 0.7);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), start + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + duration + 0.02);
}

/** Notification sound, tuned by the user's settings (style + volume). */
export function playPing(settings?: SoundSettings) {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    const style = settings?.soundStyle ?? "chime";
    const volume = (settings?.soundVolume ?? 0.6) * 0.14;
    if (volume <= 0) return;
    switch (style) {
      case "pop":
        tone(ctx, "triangle", 520, 180, 0.12, volume);
        break;
      case "blip":
        tone(ctx, "square", 1280, 900, 0.07, volume * 0.55);
        break;
      case "bell":
        tone(ctx, "sine", 1046, 1046, 0.5, volume * 0.8);
        tone(ctx, "sine", 1568, 1568, 0.42, volume * 0.45, 0.03);
        break;
      default:
        tone(ctx, "sine", 880, 1180, 0.22, volume);
    }
  } catch {
    // autoplay policy or no audio device – ignore
  }
}

/** Short call connect / hangup chimes. */
export function playCallTone(kind: "join" | "leave") {
  try {
    audioCtx ??= new AudioContext();
    const ctx = audioCtx;
    if (ctx.state === "suspended") void ctx.resume();
    if (kind === "join") {
      tone(ctx, "sine", 523, 784, 0.18, 0.09);
      tone(ctx, "sine", 784, 1046, 0.2, 0.07, 0.12);
    } else {
      tone(ctx, "sine", 660, 440, 0.18, 0.07);
    }
  } catch {
    // ignore
  }
}

/** Ringtone loop for an incoming call. Returns a stop function. */
export function startRinging(): () => void {
  let stopped = false;
  const ring = () => {
    if (stopped) return;
    try {
      audioCtx ??= new AudioContext();
      const ctx = audioCtx;
      if (ctx.state === "suspended") void ctx.resume();
      tone(ctx, "sine", 880, 880, 0.22, 0.09);
      tone(ctx, "sine", 1108, 1108, 0.26, 0.075, 0.26);
    } catch {
      // ignore
    }
  };
  ring();
  const timer = window.setInterval(ring, 2600);
  return () => {
    stopped = true;
    window.clearInterval(timer);
  };
}

/** Czech plural: 1 zpráva, 2 zprávy, 5 zpráv. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

export function formatLastSeen(ms: number): string {
  if (!ms) return "nikdy";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "právě teď";
  if (diff < 3_600_000) return `před ${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `před ${Math.floor(diff / 3_600_000)} h`;
  return formatDateTime(ms);
}

/** Human countdown for a timeout, e.g. "12 min" or "1 h 05 min". */
export function timeoutLabel(msLeft: number): string {
  if (msLeft <= 0) return "vypršel";
  const total = Math.ceil(msLeft / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${pad(m)} min`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function validColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

/** Crop an uploaded image to a centered square and shrink it for avatars. */
export async function prepareAvatar(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(512, side);
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Prohlížeč neumí upravit obrázek");
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Obrázek se nepodařilo zpracovat"))),
      "image/jpeg",
      0.9,
    );
  });
}
