import { wsURL } from "./api";
import type { CallPeer, Message, Poll, Reaction, User, WSStatus } from "./types";

export type SocketEvent = {
  type: string;
  channelId?: number;
  channelIds?: number[];
  message?: Message;
  messageId?: number;
  reactions?: Reaction[];
  poll?: Poll;
  user?: User;
  from?: CallPeer;
  userId?: number;
  online?: boolean | number[];
  participants?: CallPeer[];
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  renegotiate?: boolean;
  valid?: boolean;
  reason?: string;
};

type Listener = (event: SocketEvent) => void;
type StatusListener = (status: WSStatus) => void;

class Socket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private subscriptions: number[] = [];
  private reconnectTimer: number | null = null;
  private attempts = 0;
  private manualClose = false;
  private currentStatus: WSStatus = "offline";

  status(): WSStatus {
    return this.currentStatus;
  }

  connect() {
    this.manualClose = false;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsURL());
    } catch {
      this.setStatus("offline");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      this.setStatus("online");
      if (this.subscriptions.length > 0) {
        this.send({ type: "subscribe", channelIds: this.subscriptions });
      }
    };
    ws.onmessage = (event) => {
      let data: SocketEvent;
      try {
        data = JSON.parse(String(event.data)) as SocketEvent;
      } catch {
        return;
      }
      for (const listener of this.listeners) listener(data);
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus("offline");
      if (!this.manualClose) this.scheduleReconnect();
    };
    ws.onerror = () => {
      ws.close();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null || this.manualClose) return;
    const delay = Math.min(1000 * 2 ** this.attempts, 10_000);
    this.attempts += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setStatus(status: WSStatus) {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    for (const listener of this.statusListeners) listener(status);
  }

  subscribe(channelIds: number[]) {
    this.subscriptions = [...new Set(channelIds)];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.send({ type: "subscribe", channelIds: this.subscriptions });
    }
  }

  send(payload: Record<string, unknown>) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  close() {
    this.manualClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.setStatus("offline");
  }
}

export const socket = new Socket();

// debug helper: window.melvinSocket in devtools
if (typeof window !== "undefined") {
  (window as unknown as { melvinSocket: Socket }).melvinSocket = socket;
}

export type { Message };
