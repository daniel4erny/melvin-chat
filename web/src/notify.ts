import { isTauri } from "./api";

/**
 * Notifications work in three places:
 *  - Android/desktop Tauri builds use the native notification plugin, so the
 *    notification survives the webview being in the background.
 *  - Browsers use the Notification API.
 *  - Everything else is a silent no-op.
 */
export async function notificationsAvailable(): Promise<boolean> {
  if (isTauri()) {
    try {
      await import("@tauri-apps/plugin-notification");
      return true;
    } catch {
      return false;
    }
  }
  return "Notification" in window;
}

export async function notificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (isTauri()) {
    try {
      const { isPermissionGranted } = await import("@tauri-apps/plugin-notification");
      return (await isPermissionGranted()) ? "granted" : "default";
    } catch {
      return "unsupported";
    }
  }
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import("@tauri-apps/plugin-notification");
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  return (await Notification.requestPermission()) === "granted";
}

export async function showNotification(title: string, body: string) {
  if (isTauri()) {
    try {
      const { isPermissionGranted, sendNotification } = await import("@tauri-apps/plugin-notification");
      if (!(await isPermissionGranted())) return;
      sendNotification({ title, body });
      return;
    } catch {
      return;
    }
  }
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const note = new Notification(title, { body: body.slice(0, 180), tag: "melvin" });
    note.onclick = () => window.focus();
  } catch {
    // notifications unsupported
  }
}
