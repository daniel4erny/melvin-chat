import { useCallback, useEffect, useRef, useState } from "react";
import { api, fetchConfig } from "../api";
import { useAuth } from "../auth";
import { playCallTone, playPing, startRinging } from "../utils";
import { logEvent } from "../logs";
import { socket, type SocketEvent } from "../ws";
import { toast } from "../toast";
import type {
  AppConfig,
  CallPeer,
  Channel,
  ChannelMember,
  Message,
  Poll,
  Reaction,
  User,
  WSStatus,
} from "../types";
import { Icon } from "../components/Icon";
import { Avatar, Spinner } from "../components/ui";
import MessageList from "../components/MessageList";
import Composer from "../components/Composer";
import ChannelModal from "../components/ChannelModal";
import SettingsModal from "../components/SettingsModal";
import PollModal from "../components/PollModal";
import CallBar from "../components/CallBar";
import ProfileCard from "../components/ProfileCard";
import SearchPanel from "../components/SearchPanel";
import MemberList from "../components/MemberList";
import PinsPanel from "../components/PinsPanel";
import UserMessagesPanel from "../components/UserMessagesPanel";
import { useCall } from "../useCall";
import "../styles/chat.css";

const DEFAULT_CONFIG: AppConfig = {
  maxUploadMB: 500,
  iceServers: ["stun:stun.l.google.com:19302"],
  registrationOpen: true,
  needsInvite: false,
  version: "dev",
};

function previewLabel(channel: Channel): string {
  const last = channel.lastMessage;
  if (!last) return "Žádné zprávy";
  if (last.text.trim()) return `${last.displayName}: ${last.text}`;
  if (last.kind === "voice") return `${last.displayName}: hlasovka`;
  if (last.kind === "image") return `${last.displayName}: fotka`;
  if (last.kind === "video") return `${last.displayName}: video`;
  if (last.kind === "audio") return `${last.displayName}: audio`;
  if (last.fileName) return `${last.displayName}: ${last.fileName}`;
  return `${last.displayName}: zpráva`;
}

function channelTitle(channel?: Channel | null): string {
  if (!channel) return "";
  if (channel.visibility === "direct") return channel.peer?.displayName ?? "Přímá zpráva";
  return channel.name;
}

function notifyMessage(message: Message, channel?: Channel) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const body = message.text || (message.attachment ? `Příloha: ${message.attachment.name}` : "Nová zpráva");
    const note = new Notification(`${channel?.visibility === "direct" ? "" : "#"}${channelTitle(channel) || "kanál"} · ${message.user.displayName}`, {
      body: body.slice(0, 160),
      tag: `melvin-${message.channelId}`,
    });
    note.onclick = () => window.focus();
  } catch {
    // notifications unsupported
  }
}

export default function Chat() {
  const { user, updateUser, logout, refresh } = useAuth();
  const me = user as User;

  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeId, setActiveId] = useState<number | null>(() => {
    const saved = Number(localStorage.getItem("melvin.channel"));
    return Number.isFinite(saved) && saved > 0 ? saved : null;
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [online, setOnline] = useState<Set<number>>(new Set());
  const [typing, setTyping] = useState<Map<number, { name: string; expires: number }>>(new Map());
  const [recordingUsers, setRecordingUsers] = useState<Record<number, Record<number, { name: string; expires: number }>>>({});
  const [callRoster, setCallRoster] = useState<Record<number, CallPeer[]>>({});
  const [wsStatus, setWsStatus] = useState<WSStatus>("connecting");
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [channelModal, setChannelModal] = useState<{ mode: "create" | "edit"; channel: Channel | null } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [membersRail, setMembersRail] = useState(() => localStorage.getItem("melvin.membersRail") !== "0");
  const [isCompact, setIsCompact] = useState(() => window.matchMedia("(max-width: 1100px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [ring, setRing] = useState<{ channelId: number; from: CallPeer } | null>(null);
  const [profileUser, setProfileUser] = useState<User | null>(null);
  const [messagesUser, setMessagesUser] = useState<User | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState<Message[]>([]);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [clock, setClock] = useState(Date.now());
  const focusTimer = useRef<number | null>(null);
  const pendingJump = useRef<{ channelId: number; messageId: number } | null>(null);

  const activeRef = useRef<number | null>(activeId);
  const channelsRef = useRef<Channel[]>(channels);
  const messagesRef = useRef<Message[]>(messages);
  const userRef = useRef<User>(me);
  const readAt = useRef<Record<number, number>>({});
  const lastTypingExpiry = useRef(0);
  activeRef.current = activeId;
  channelsRef.current = channels;
  messagesRef.current = messages;
  userRef.current = me;

  useEffect(() => {
    fetchConfig()
      .then(setConfig)
      .catch((err) => logEvent("warn", "Nepodařilo se načíst config", err));
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    const update = () => setIsCompact(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    localStorage.setItem("melvin.membersRail", membersRail ? "1" : "0");
  }, [membersRail]);

  useEffect(() => {
    if (!me.timeoutUntil || me.timeoutUntil <= Date.now()) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [me.timeoutUntil]);

  const timeoutMs = me.timeoutUntil ? Math.max(0, me.timeoutUntil - clock) : 0;

  const markRead = useCallback((channelId: number, messageId?: number) => {
    const now = Date.now();
    if (messageId && (readAt.current[channelId] ?? 0) + 1500 > now) return;
    if (messageId) readAt.current[channelId] = now;
    api(`/api/channels/${channelId}/read`, {
      method: "POST",
      body: { messageId: messageId ?? 0 },
    }).catch(() => undefined);
  }, []);

  const addMessage = useCallback((message: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === message.id)) {
        return prev.map((m) => (m.id === message.id ? message : m));
      }
      return [...prev, message];
    });
  }, []);

  const refreshChannels = useCallback(async (selectId?: number | null) => {
    try {
      const res = await api<{ channels: Channel[] }>("/api/channels");
      const list = res.channels;
      setChannels(list);
      channelsRef.current = list;
      socket.subscribe(list.map((c) => c.id));
      if (selectId !== undefined && selectId !== null) {
        setActiveId(selectId);
        return;
      }
      const current = activeRef.current;
      if (!current || !list.some((c) => c.id === current)) {
        setActiveId(list[0]?.id ?? null);
      }
    } catch (err) {
      logEvent("error", "Načtení kanálů selhalo", err);
      toast.error(err instanceof Error ? err.message : "Kanály se nepodařilo načíst");
    } finally {
      setLoadingChannels(false);
    }
  }, []);

  const refreshMembers = useCallback(async () => {
    const id = activeRef.current;
    if (!id) return;
    try {
      const res = await api<{ members: ChannelMember[] }>(`/api/channels/${id}`);
      setMembers(res.members);
    } catch {
      // member list is refreshed on the next channel open anyway
    }
  }, []);

  useEffect(() => {
    void refreshChannels();
  }, [refreshChannels]);

  useEffect(() => {
    activeRef.current = activeId;
    setReplyTo(null);
    setTyping(new Map());
    setMessages([]);
    setMembers([]);
    setHasMore(false);
    setPins([]);
    if (activeId === null) {
      setLoadingMessages(false);
      return;
    }
    localStorage.setItem("melvin.channel", String(activeId));
    let cancelled = false;
    setLoadingMessages(true);

    const jump = pendingJump.current?.channelId === activeId ? pendingJump.current : null;
    const messageURL = jump
      ? `/api/channels/${activeId}/messages?around=${jump.messageId}&limit=50`
      : `/api/channels/${activeId}/messages?limit=50`;

    api<{ messages: Message[]; hasMore: boolean }>(messageURL)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
        messagesRef.current = res.messages;
        setHasMore(res.hasMore);
        const last = res.messages[res.messages.length - 1];
        if (last) markRead(activeId, last.id);
        if (jump) {
          setFocusId(jump.messageId);
          if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
          focusTimer.current = window.setTimeout(() => setFocusId(null), 2400);
          pendingJump.current = null;
        }
      })
      .catch((err) => {
        if (!cancelled) toast.error(err instanceof Error ? err.message : "Zprávy se nepodařilo načíst");
      })
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });

    api<{ channel: Channel; members: ChannelMember[] }>(`/api/channels/${activeId}`)
      .then((res) => {
        if (cancelled) return;
        setMembers(res.members);
        setChannels((prev) => {
          const next = prev.map((c) => (c.id === activeId ? { ...c, unread: 0 } : c));
          channelsRef.current = next;
          return next;
        });
      })
      .catch((err) => {
        if (!cancelled) logEvent("warn", "Detail kanálu selhal", err);
      });

    api<{ messages: Message[] }>(`/api/channels/${activeId}/pins`)
      .then((res) => {
        if (!cancelled) setPins(res.messages);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [activeId, markRead]);

  useEffect(() => {
    const onFocus = () => {
      const id = activeRef.current;
      const list = messagesRef.current;
      if (id && list.length > 0) markRead(id, list[list.length - 1]!.id);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [markRead]);

  useEffect(() => {
    const total = channels.reduce((sum, c) => sum + c.unread, 0);
    document.title = total > 0 ? `(${total}) Melvin` : "Melvin";
  }, [channels]);

  useEffect(() => {
    if (!ring) return;
    const timer = window.setTimeout(() => setRing(null), 40_000);
    return () => clearTimeout(timer);
  }, [ring]);

  useEffect(() => {
    if (!ring || !userRef.current.settings.callSounds) return;
    const stop = startRinging();
    return stop;
  }, [ring]);

  const call = useCall(config);
  const callRef = useRef(call);
  callRef.current = call;

  const openChannel = useCallback((id: number) => {
    setActiveId(id);
    setSidebarOpen(false);
    setSearchOpen(false);
    setPinsOpen(false);
    setProfileUser(null);
    setMessagesUser(null);
  }, []);

  const jumpToMessage = useCallback(async (messageId: number) => {
    const channelId = activeRef.current;
    if (!channelId) return;
    setSearchOpen(false);
    setPinsOpen(false);
    try {
      const res = await api<{ messages: Message[]; hasMore: boolean }>(
        `/api/channels/${channelId}/messages?around=${messageId}&limit=50`,
      );
      setMessages(res.messages);
      messagesRef.current = res.messages;
      setHasMore(res.hasMore);
      setFocusId(messageId);
      if (focusTimer.current !== null) window.clearTimeout(focusTimer.current);
      focusTimer.current = window.setTimeout(() => setFocusId(null), 2400);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Na zprávu se nepodařilo skočit");
    }
  }, []);

  const openMessageAt = useCallback(
    (channelId: number, messageId: number) => {
      setMessagesUser(null);
      setProfileUser(null);
      setPinsOpen(false);
      setSearchOpen(false);
      setSidebarOpen(false);
      if (activeRef.current === channelId) {
        void jumpToMessage(messageId);
        return;
      }
      pendingJump.current = { channelId, messageId };
      setActiveId(channelId);
    },
    [jumpToMessage],
  );

  const openProfileByUsername = useCallback(
    (username: string) => {
      const found = members.find((member) => member.username.toLowerCase() === username.toLowerCase());
      if (found) setProfileUser(found);
      else toast.info(`Uživatel @${username} není v tomto kanálu`);
    },
    [members],
  );

  const sendMessage = useCallback(
    async (text: string, attachmentId?: string, replyToId?: number) => {
      const id = activeRef.current;
      if (!id) return;
      try {
        const res = await api<{ message: Message }>(`/api/channels/${id}/messages`, {
          method: "POST",
          body: { text, attachmentId, replyTo: replyToId },
        });
        addMessage(res.message);
        markRead(id, res.message.id);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Zprávu se nepodařilo odeslat");
        throw err;
      }
    },
    [addMessage, markRead],
  );

  const editMessage = useCallback(async (message: Message, text: string) => {
    try {
      const res = await api<{ message: Message }>(`/api/messages/${message.id}`, {
        method: "PATCH",
        body: { text },
      });
      setMessages((prev) => prev.map((m) => (m.id === message.id ? res.message : m)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Úprava zprávy selhala");
      throw err;
    }
  }, []);

  const deleteMessage = useCallback(async (message: Message) => {
    if (!window.confirm("Smazat tuhle zprávu?")) return;
    try {
      await api(`/api/messages/${message.id}`, { method: "DELETE" });
      setMessages((prev) =>
        prev.map((m) =>
          m.id === message.id ? { ...m, deleted: true, text: "", attachment: undefined, reactions: [] } : m,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Smazání selhalo");
    }
  }, []);

  const react = useCallback(async (message: Message, emoji: string) => {
    try {
      const res = await api<{ reactions: Reaction[] }>(`/api/messages/${message.id}/reactions`, {
        method: "POST",
        body: { emoji },
      });
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, reactions: res.reactions } : m)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reakce selhala");
    }
  }, []);

  const togglePin = useCallback(async (message: Message) => {
    try {
      await api(`/api/messages/${message.id}/pin`, { method: message.pinned ? "DELETE" : "POST" });
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, pinned: !message.pinned } : m)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Připnutí selhalo");
    }
  }, []);

  const votePoll = useCallback(async (poll: Poll, optionIds: number[]) => {
    try {
      const res = await api<{ poll: Poll }>(`/api/polls/${poll.id}/vote`, {
        method: "POST",
        body: { optionIds },
      });
      setMessages((prev) => prev.map((m) => (m.poll?.id === poll.id ? { ...m, poll: res.poll } : m)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Hlasování selhalo");
    }
  }, []);

  const closePoll = useCallback(async (poll: Poll) => {
    if (!window.confirm("Uzavřít anketu? Už nepůjde hlasovat.")) return;
    try {
      const res = await api<{ poll: Poll }>(`/api/polls/${poll.id}/close`, { method: "POST", body: {} });
      setMessages((prev) => prev.map((m) => (m.poll?.id === poll.id ? { ...m, poll: res.poll } : m)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Anketu se nepodařilo uzavřít");
    }
  }, []);

  const createPoll = useCallback(
    async (question: string, options: string[], multi: boolean, anonymous: boolean) => {
      const id = activeRef.current;
      if (!id) return;
      const res = await api<{ message: Message }>(`/api/channels/${id}/polls`, {
        method: "POST",
        body: { question, options, multi, anonymous },
      });
      addMessage(res.message);
      markRead(id, res.message.id);
    },
    [addMessage, markRead],
  );

  const loadOlder = useCallback(async () => {
    const id = activeRef.current;
    if (!id || loadingOlder || !hasMore) return;
    const current = messagesRef.current;
    if (current.length === 0) return;
    setLoadingOlder(true);
    try {
      const res = await api<{ messages: Message[]; hasMore: boolean }>(
        `/api/channels/${id}/messages?before=${current[0]!.id}&limit=50`,
      );
      setMessages((prev) => [...res.messages, ...prev]);
      setHasMore(res.hasMore);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Starší zprávy se nepodařilo načíst");
    } finally {
      setLoadingOlder(false);
    }
  }, [hasMore, loadingOlder]);

  // live socket events
  const handlerRef = useRef<(event: SocketEvent) => void>(() => undefined);
  handlerRef.current = (event: SocketEvent) => {
    switch (event.type) {
      case "hello": {
        if (Array.isArray(event.online)) setOnline(new Set(event.online));
        break;
      }
      case "presence": {
        if (typeof event.userId === "number" && typeof event.online === "boolean") {
          setOnline((prev) => {
            const next = new Set(prev);
            if (event.online) next.add(event.userId!);
            else next.delete(event.userId!);
            return next;
          });
          if (event.online) {
            setMembers((prev) => prev.map((m) => (m.id === event.userId ? { ...m, online: true } : m)));
          }
        }
        break;
      }
      case "message:new": {
        const message = event.message;
        if (!message) break;
        const isActive = message.channelId === activeRef.current;
        if (isActive && !message.deleted) {
          addMessage(message);
          if (!document.hidden) markRead(message.channelId, message.id);
        }
        setChannels((prev) => {
          const next = prev.map((channel) =>
            channel.id === message.channelId
              ? {
                  ...channel,
                  lastMessage: {
                    text: message.text,
                    createdAt: message.createdAt,
                    displayName: message.user.displayName,
                    kind: message.attachment?.kind ?? "",
                    fileName: message.attachment?.name ?? "",
                  },
                  unread:
                    channel.id === activeRef.current && !document.hidden
                      ? 0
                      : channel.unread + (message.user.id === me.id ? 0 : 1),
                }
              : channel,
          );
          channelsRef.current = next;
          return next;
        });
        if (message.user.id !== me.id) {
          const channel = channelsRef.current.find((c) => c.id === message.channelId);
          const away = document.hidden || message.channelId !== activeRef.current;
          if (away && userRef.current.settings.messageSound) playPing(userRef.current.settings);
          if (away && userRef.current.settings.notifications) notifyMessage(message, channel);
        }
        break;
      }
      case "message:deleted": {
        if (typeof event.messageId === "number") {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.messageId
                ? { ...m, deleted: true, text: "", attachment: undefined, reactions: [], pinned: false }
                : m,
            ),
          );
          setPins((prev) => prev.filter((m) => m.id !== event.messageId));
        }
        break;
      }
      case "message:updated": {
        if (event.message) {
          const updated = event.message;
          setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
          setPins((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
        }
        break;
      }
      case "message:pinned": {
        if (event.message) {
          const pinned = event.message;
          setPins((prev) => [pinned, ...prev.filter((m) => m.id !== pinned.id)]);
          setMessages((prev) => prev.map((m) => (m.id === pinned.id ? { ...m, pinned: true } : m)));
        }
        break;
      }
      case "message:unpinned": {
        if (typeof event.messageId === "number") {
          setPins((prev) => prev.filter((m) => m.id !== event.messageId));
          setMessages((prev) => prev.map((m) => (m.id === event.messageId ? { ...m, pinned: false } : m)));
        }
        break;
      }
      case "reaction:update": {
        if (typeof event.messageId === "number" && event.reactions) {
          setMessages((prev) =>
            prev.map((m) => (m.id === event.messageId ? { ...m, reactions: event.reactions! } : m)),
          );
        }
        break;
      }
      case "poll:update": {
        if (event.poll) {
          const poll = event.poll;
          setMessages((prev) => prev.map((m) => (m.poll?.id === poll.id ? { ...m, poll } : m)));
        }
        break;
      }
      case "typing": {
        if (event.user && event.channelId === activeRef.current && event.user.id !== me.id) {
          const arrival = event.user;
          setTyping((prev) => new Map(prev).set(arrival.id, { name: arrival.displayName, expires: Date.now() + 4500 }));
          lastTypingExpiry.current = Date.now() + 4500;
          window.setTimeout(() => {
            setTyping((prev) => {
              const entry = prev.get(arrival.id);
              if (!entry || entry.expires > Date.now()) return prev;
              const next = new Map(prev);
              next.delete(arrival.id);
              return next;
            });
          }, 4600);
        }
        break;
      }
      case "voice:recording": {
        const channelId = event.channelId;
        const arrival = event.user;
        if (typeof channelId !== "number" || !arrival || typeof arrival.id !== "number") break;
        const userId = arrival.id;
        setRecordingUsers((prev) => {
          const channel = { ...(prev[channelId] ?? {}) };
          if (event.recording) channel[userId] = { name: arrival.displayName, expires: Date.now() + 310_000 };
          else delete channel[userId];
          return { ...prev, [channelId]: channel };
        });
        if (event.recording) {
          window.setTimeout(() => {
            setRecordingUsers((prev) => {
              const channel = prev[channelId];
              const entry = channel?.[userId];
              if (!entry || entry.expires > Date.now()) return prev;
              const nextChannel = { ...channel };
              delete nextChannel[userId];
              return { ...prev, [channelId]: nextChannel };
            });
          }, 311_000);
        }
        break;
      }
      case "channels:changed": {
        void refreshChannels();
        break;
      }
      case "mention": {
        const mentionMessage = event.message;
        if (mentionMessage && mentionMessage.user.id !== me.id) {
          const channel = channelsRef.current.find((c) => c.id === mentionMessage.channelId);
          toast.info(
            `${mentionMessage.user.displayName} tě zmínil${
              channel
                ? channel.visibility === "direct"
                  ? " v přímé zprávě"
                  : ` v #${channel.name}`
                : ""
            }`,
          );
          if (userRef.current.settings.messageSound) playPing(userRef.current.settings);
        }
        break;
      }
      case "user:updated": {
        if (event.user) {
          const updated = event.user;
          setMembers((prev) =>
            prev.map((member) => (member.id === updated.id ? { ...member, ...updated } : member)),
          );
          setProfileUser((prev) => (prev && prev.id === updated.id ? updated : prev));
          if (updated.id === me.id) void refresh();
        }
        break;
      }
      case "user:timeout": {
        if (event.userId === me.id) {
          const reason = event.reason ? `: ${event.reason}` : "";
          toast.error(`Dostal(a) jsi timeout${reason}`);
          void refresh();
        }
        break;
      }
      case "timeout:blocked": {
        toast.error(typeof event.message === "string" ? event.message : "Máš timeout – teď nemůžeš pokračovat.");
        callRef.current.leave();
        break;
      }
      case "users:changed": {
        void refreshMembers();
        break;
      }
      case "user:banned": {
        const reason = typeof event.reason === "string" && event.reason ? `: ${event.reason}` : "";
        if (event.userId === me.id) {
          toast.error(`Tvůj účet byl zabanován${reason}`);
          window.setTimeout(() => void logout(), 900);
        }
        break;
      }
      case "call:ring": {
        if (event.from && event.channelId && event.from.id !== me.id && !callRef.current.state) {
          setRing({ channelId: event.channelId, from: event.from });
        }
        break;
      }
      case "call:state": {
        if (typeof event.channelId === "number") {
          setCallRoster((prev) => ({ ...prev, [event.channelId!]: event.participants ?? [] }));
        }
        break;
      }
      case "call:participants":
      case "call:peer-joined":
      case "call:peer-left":
      case "call:offer":
      case "call:answer":
      case "call:ice":
      case "call:mute": {
        callRef.current.handleEvent(event);
        break;
      }
    }
  };

  useEffect(() => {
    socket.connect();
    const offEvent = socket.on((event) => handlerRef.current(event));
    const offStatus = socket.onStatus((status) => {
      setWsStatus(status);
      if (status === "online") void refreshChannels();
    });
    return () => {
      offEvent();
      offStatus();
    };
  }, [refreshChannels]);

  const activeChannel = channels.find((c) => c.id === activeId) ?? null;
  const isDM = activeChannel?.visibility === "direct";
  const dmPeer = activeChannel?.peer;
  const activeLabel = channelTitle(activeChannel);
  const textChannels = channels.filter((c) => c.visibility !== "direct");
  const dmChannels = channels.filter((c) => c.visibility === "direct");
  const typingNames = [...typing.values()].map((t) => t.name);
  const activeRecordings = (activeId !== null ? recordingUsers[activeId] : undefined) ?? {};
  const recordingNames = Object.entries(activeRecordings)
    .filter(([id]) => Number(id) !== me.id)
    .map(([, entry]) => entry.name);
  const inCallHere = call.state?.channelId === activeId;
  const callChannelName = call.state
    ? channelTitle(channels.find((c) => c.id === call.state?.channelId))
    : "";
  const ringChannel = ring ? channels.find((c) => c.id === ring.channelId) : null;
  const onlineMembers = new Set(online);
  const canEdit = Boolean(
    activeChannel && !isDM && (activeChannel.ownerId === me.id || me.admin),
  );
  const canPin = canEdit;
  const dmOnline = Boolean(dmPeer && online.has(dmPeer.id));
  const activeCallPeers = (activeId !== null ? callRoster[activeId] : undefined) ?? [];
  const activeCallIds = new Set(activeCallPeers.map((peer) => peer.id));
  const activeRecordingIds = new Set(Object.keys(activeRecordings).map(Number));
  const onlineCount = members.filter((member) => online.has(member.id)).length;

  const leaveChannel = async () => {
    if (!activeChannel) return;
    if (!window.confirm(`Opustit #${activeChannel.name}?`)) return;
    try {
      await api(`/api/channels/${activeChannel.id}/leave`, { method: "POST", body: {} });
      setMembersOpen(false);
      await refreshChannels();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Odejít se nepodařilo");
    }
  };

  const startDM = async (target: User) => {
    try {
      const res = await api<{ channel: Channel }>("/api/dms", {
        method: "POST",
        body: { userId: target.id },
      });
      await refreshChannels(res.channel.id);
      setProfileUser(null);
      setMessagesUser(null);
      setSidebarOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Konverzaci se nepodařilo otevřít");
    }
  };

  const joinCall = async () => {
    if (!activeChannel) return;
    await call.join(activeChannel.id);
    if (me.settings.callSounds) playCallTone("join");
  };

  const leaveCall = () => {
    call.leave();
    if (me.settings.callSounds) playCallTone("leave");
  };

  const callForUi = { ...call, leave: leaveCall };

  const openMembers = () => {
    if (isCompact) setMembersOpen(true);
    else setMembersRail((open) => !open);
  };

  return (
    <div className="appShell">
      {sidebarOpen && <div className="sidebarScrim" onClick={() => setSidebarOpen(false)} />}

      <aside className={`sidebar${sidebarOpen ? " open" : ""}`}>
        <div className="sidebarBrand">
          <span className="brandMark small">M</span>
          <span className="brandName">Melvin</span>
          <span className={`connDot ${wsStatus}`} title={`Připojení: ${wsStatus}`} />
        </div>

        <div className="sidebarSection dmSection">
          <span>Přímé zprávy · {dmChannels.length}</span>
        </div>
        <nav className="channelList dmList">
          {dmChannels.map((channel) => {
            const peers = callRoster[channel.id] ?? [];
            const peer = channel.peer;
            return (
              <button
                key={channel.id}
                className={`channelItem dmItem${channel.id === activeId ? " active" : ""}`}
                onClick={() => openChannel(channel.id)}
              >
                {peer ? (
                  <Avatar
                    name={peer.displayName}
                    color={peer.avatarColor}
                    avatarId={peer.avatarId}
                    size={28}
                    online={online.has(peer.id)}
                  />
                ) : (
                  <span className="channelIcon">
                    <Icon name="user" size={17} />
                  </span>
                )}
                <span className="channelInfo">
                  <span className="channelName">{peer?.displayName ?? "Přímá zpráva"}</span>
                  <span className="channelPreview">
                    {peers.length > 0 ? (
                      <>
                        <Icon name="phone" size={11} /> v hovoru
                      </>
                    ) : (
                      previewLabel(channel)
                    )}
                  </span>
                </span>
                {peers.length > 0 && !channel.unread && (
                  <span className="callMini" title="V hovoru">
                    <Icon name="phone" size={11} />
                  </span>
                )}
                {channel.unread > 0 && (
                  <span className="unreadBadge">{channel.unread > 99 ? "99+" : channel.unread}</span>
                )}
              </button>
            );
          })}
          {!loadingChannels && dmChannels.length === 0 && (
            <p className="sidebarEmpty dmEmpty">
              Otevři profil člena a napiš mu zprávu.
            </p>
          )}
        </nav>

        <div className="sidebarSection">
          <span>Kanály · {textChannels.length}</span>
          <button
            className="iconBtn"
            title="Nový kanál"
            aria-label="Nový kanál"
            onClick={() => setChannelModal({ mode: "create", channel: null })}
          >
            <Icon name="plus" size={17} />
          </button>
        </div>

        <nav className="channelList">
          {textChannels.map((channel) => {
            const peers = callRoster[channel.id] ?? [];
            const isRecording = Object.keys(recordingUsers[channel.id] ?? {}).some((id) => Number(id) !== me.id);
            return (
              <button
                key={channel.id}
                className={`channelItem${channel.id === activeId ? " active" : ""}`}
                onClick={() => openChannel(channel.id)}
              >
                <span className="channelIcon">
                  <Icon name={channel.visibility === "private" ? "lock" : "hash"} size={17} />
                </span>
                <span className="channelInfo">
                  <span className="channelName">{channel.name}</span>
                  <span className="channelPreview">
                    {peers.length > 0 ? (
                      <>
                        <Icon name="phone" size={11} /> {peers.length} v hovoru
                      </>
                    ) : isRecording ? (
                      "někdo nahrává…"
                    ) : (
                      previewLabel(channel)
                    )}
                  </span>
                </span>
                {isRecording && <span className="recordingMini" title="Někdo nahrává hlasovku" />}
                {peers.length > 0 && !channel.unread && (
                  <span className="callMini" title={`${peers.length} v hovoru`}>
                    <Icon name="phone" size={11} />
                  </span>
                )}
                {channel.unread > 0 && (
                  <span className="unreadBadge">{channel.unread > 99 ? "99+" : channel.unread}</span>
                )}
              </button>
            );
          })}
          {!loadingChannels && textChannels.length === 0 && (
            <p className="sidebarEmpty">
              Zatím žádné kanály.
              <br />
              Vytvoř první!
            </p>
          )}
          {loadingChannels && (
            <div className="sidebarLoading">
              <Spinner size={18} />
            </div>
          )}
        </nav>


        <div className="sidebarSpacer" />

        <div className="userPanel">
          <button className="userCard" onClick={() => setSettingsOpen(true)}>
            <Avatar
              name={me.displayName}
              color={me.avatarColor}
              avatarId={me.avatarId}
              size={36}
              online={wsStatus === "online"}
            />
            <span className="userInfo">
              <strong>{me.displayName}</strong>
              <small>
                {timeoutMs > 0
                  ? "⏱ timeout"
                  : me.statusEmoji || me.statusText
                    ? `${me.statusEmoji} ${me.statusText}`.trim()
                    : `@${me.username}`}
              </small>
            </span>
            <Icon name="settings" size={16} />
          </button>
        </div>
      </aside>

      <main className="chatPane">
        <header className="chatHeader">
          <button className="iconBtn mobileOnly" onClick={() => setSidebarOpen(true)} aria-label="Menu">
            <Icon name="menu" size={20} />
          </button>

          {activeChannel ? (
            <div
              className={`headerChannel${isDM ? " dmHeader dmHeaderClickable" : ""}`}
              onClick={() => {
                if (isDM && dmPeer) setProfileUser(dmPeer);
              }}
              role={isDM ? "button" : undefined}
              title={isDM ? "Otevřít profil" : undefined}
            >
              <span className="headerChannelIcon">
                {isDM && dmPeer ? (
                  <Avatar
                    name={dmPeer.displayName}
                    color={dmPeer.avatarColor}
                    avatarId={dmPeer.avatarId}
                    size={28}
                    online={dmOnline}
                  />
                ) : (
                  <Icon name={activeChannel.visibility === "private" ? "lock" : "hash"} size={20} />
                )}
              </span>
              <div className="headerChannelText">
                <h1>{activeLabel}</h1>
                <p>
                  {isDM
                    ? dmOnline
                      ? "online"
                      : "offline"
                    : activeChannel.topic ||
                      (activeChannel.visibility === "private" ? "Soukromý kanál" : "Veřejný kanál")}
                  {!isDM && (
                    <>
                      <span className="headerDot">·</span>
                      {onlineCount} online
                    </>
                  )}
                  {activeCallPeers.length > 0 && (
                    <>
                      <span className="headerDot">·</span>
                      <span className="headerCallInfo">
                        <Icon name="phone" size={11} /> {activeCallPeers.length} v hovoru
                      </span>
                    </>
                  )}
                </p>
              </div>
            </div>
          ) : (
            <div className="headerChannel">
              <span className="headerChannelIcon">
                <Icon name="hash" size={20} />
              </span>
              <div className="headerChannelText">
                <h1>Melvin</h1>
                <p>Vyber nebo vytvoř kanál</p>
              </div>
            </div>
          )}

          <div className="headerActions">
            <span className={`wsBadge ${wsStatus}`} title={`Připojení: ${wsStatus}`}>
              <span className={`dot ${wsStatus}`} />
              <span className="wsText">
                {wsStatus === "online" ? "online" : wsStatus === "connecting" ? "připojuji" : "offline"}
              </span>
            </span>

            {activeChannel && (
              <button
                className={`iconBtn searchBtn${searchOpen ? " active" : ""}`}
                title="Hledat ve zprávách"
                aria-label="Hledat ve zprávách"
                onClick={() => setSearchOpen((open) => !open)}
              >
                <Icon name="search" size={18} />
              </button>
            )}

            {activeChannel && !isDM && (
              <button
                className={`iconBtn pinHeaderBtn${pinsOpen ? " active" : ""}`}
                title="Připnuté zprávy"
                aria-label="Připnuté zprávy"
                onClick={() => setPinsOpen((open) => !open)}
              >
                <Icon name="pin" size={18} />
                {pins.length > 0 && <span className="headerBadge pinned">{pins.length}</span>}
              </button>
            )}

            {activeChannel && !isDM && (
              <button
                className={`iconBtn memberBtn${membersRail && !isCompact ? " active" : ""}`}
                title="Členové kanálu"
                aria-label="Členové kanálu"
                onClick={openMembers}
              >
                <Icon name="users" size={18} />
                <span className="memberCount">{members.length || activeChannel.memberCount}</span>
              </button>
            )}

            {activeChannel && canEdit && (
              <button
                className="iconBtn"
                title="Upravit kanál"
                aria-label="Upravit kanál"
                onClick={() => setChannelModal({ mode: "edit", channel: activeChannel })}
              >
                <Icon name="settings" size={18} />
              </button>
            )}

            {activeChannel && (
              <button
                className={`iconBtn callHeaderBtn${inCallHere ? " active" : ""}`}
                onClick={() => {
                  if (inCallHere) leaveCall();
                  else void joinCall();
                }}
                title={inCallHere ? "Zavěsit hovor" : "Zavolat do kanálu"}
                aria-label={inCallHere ? "Zavěsit hovor" : "Zavolat do kanálu"}
              >
                <Icon name={inCallHere ? "phoneOff" : "phone"} size={18} />
                {activeCallPeers.length > 0 && <span className="headerBadge call">{activeCallPeers.length}</span>}
              </button>
            )}
          </div>
        </header>

        <div className="chatWorkspace">
          <div className="chatColumn">
            {wsStatus === "offline" && (
              <div className="offlineBar">
                <Icon name="alert" size={15} /> Připojení ztraceno. Zkouším se znovu připojit…
              </div>
            )}

            {ring && ringChannel && (
              <div className="ringBanner">
                <span className="ringPulse">
                  <Icon name="phone" size={18} />
                </span>
                <div className="ringText">
                  <strong>{ring.from.displayName} volá</strong>
                  <span>
                    {ringChannel.visibility === "direct"
                      ? "v přímém hovoru"
                      : `v kanálu #${ringChannel.name}`}
                  </span>
                </div>
                <button
                  className="btn primary tiny"
                  onClick={() => {
                    void call.join(ring.channelId);
                    if (me.settings.callSounds) playCallTone("join");
                    setRing(null);
                  }}
                >
                  Připojit se
                </button>
                <button className="iconBtn" onClick={() => setRing(null)} aria-label="Ignorovat">
                  <Icon name="x" size={16} />
                </button>
              </div>
            )}

            {searchOpen && activeChannel && (
              <SearchPanel
                channelId={activeChannel.id}
                channelName={activeLabel}
                dm={isDM}
                onJump={(id) => void jumpToMessage(id)}
                onClose={() => setSearchOpen(false)}
              />
            )}

            <div className="chatBody">
              {activeChannel ? (
                <>
                  <MessageList
                    messages={messages}
                    me={me}
                    channelId={activeChannel.id}
                    channelName={activeLabel}
                    dm={isDM}
                    loading={loadingMessages}
                    hasMore={hasMore}
                    loadingOlder={loadingOlder}
                    typingNames={typingNames}
                    showTimestamps={me.settings.showTimestamps}
                    focusId={focusId}
                    canPin={canPin}
                    onPin={(message) => void togglePin(message)}
                    onLoadOlder={() => void loadOlder()}
                    onReact={(message, emoji) => void react(message, emoji)}
                    onDelete={(message) => void deleteMessage(message)}
                    onEdit={editMessage}
                    onReply={setReplyTo}
                    onVote={(poll, ids) => void votePoll(poll, ids)}
                    onClosePoll={(poll) => void closePoll(poll)}
                    onProfile={setProfileUser}
                    onMention={openProfileByUsername}
                  />
                  {recordingNames.length > 0 && (
                    <div className="recordingPeers">
                      <span className="recordDot tiny" />
                      <span>
                        {recordingNames.length === 1
                          ? `${recordingNames[0]} nahrává hlasovku…`
                          : `${recordingNames.join(", ")} nahrávají hlasovky…`}
                      </span>
                    </div>
                  )}
                  <Composer
                    channelId={activeChannel.id}
                    channelName={activeLabel}
                    dm={isDM}
                    replyTo={replyTo}
                    maxUploadMB={config.maxUploadMB}
                    enterToSend={me.settings.enterToSend}
                    members={members}
                    timeoutMsLeft={timeoutMs}
                    timeoutReason={me.timeoutReason}
                    onCancelReply={() => setReplyTo(null)}
                    onSend={sendMessage}
                    onPoll={() => setPollOpen(true)}
                  />
                </>
              ) : (
                <div className="welcomePane">
                  <div className="welcomeMark">M</div>
                  <h2>Vítej v Melvinu{me.displayName ? `, ${me.displayName}` : ""}!</h2>
                  <p>
                    {loadingChannels
                      ? "Načítám kanály…"
                      : channels.length === 0
                        ? "Zatím tu není žádný kanál. Vytvoř první a pozvi partu."
                        : "Vyber kanál vlevo a začni psát."}
                  </p>
                  <button className="btn primary" onClick={() => setChannelModal({ mode: "create", channel: null })}>
                    <Icon name="plus" size={17} /> Vytvořit kanál
                  </button>
                  <div className="welcomeHints">
                    <span>
                      <Icon name="mic" size={15} /> hlasovky
                    </span>
                    <span>
                      <Icon name="phone" size={15} /> hovory
                    </span>
                    <span>
                      <Icon name="poll" size={15} /> ankety
                    </span>
                    <span>
                      <Icon name="paperclip" size={15} /> soubory do {config.maxUploadMB} MB
                    </span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {!isCompact && !isDM && membersRail && activeChannel && (
            <aside className="memberRail">
              <header className="memberRailHead">
                <div>
                  <h3>Členové</h3>
                  <p>{onlineCount} online · {members.length} celkem</p>
                </div>
                <div className="row gap">
                  <button
                    className="iconBtn"
                    title="Spravovat členy"
                    aria-label="Spravovat členy"
                    onClick={() => setChannelModal({ mode: "edit", channel: activeChannel })}
                  >
                    <Icon name="settings" size={15} />
                  </button>
                  <button
                    className="iconBtn"
                    title="Skrýt panel"
                    aria-label="Skrýt panel"
                    onClick={() => setMembersRail(false)}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
              </header>
              <MemberList
                members={members}
                online={onlineMembers}
                me={me}
                callIds={activeCallIds}
                recordingIds={activeRecordingIds}
                onProfile={setProfileUser}
                channelName={activeChannel.name}
              />
            </aside>
          )}
        </div>
      </main>

      {call.state && (
        <CallBar
          call={callForUi}
          channelName={callChannelName}
          dm={channels.find((c) => c.id === call.state?.channelId)?.visibility === "direct"}
          peers={call.state.peers}
        />
      )}

      {membersOpen && activeChannel && (
        <div className="drawerScrim" onClick={() => setMembersOpen(false)}>
          <aside className="membersDrawer" onClick={(e) => e.stopPropagation()}>
            <header className="drawerHead">
              <div>
                <h3>Členové</h3>
                <p>
                  #{activeChannel.name} · {onlineCount} online / {members.length}
                </p>
              </div>
              <button className="iconBtn" onClick={() => setMembersOpen(false)} aria-label="Zavřít">
                <Icon name="x" size={18} />
              </button>
            </header>
            <div className="membersList">
              <MemberList
                members={members}
                online={onlineMembers}
                me={me}
                callIds={activeCallIds}
                recordingIds={activeRecordingIds}
                onProfile={(member) => {
                  setMembersOpen(false);
                  setProfileUser(member);
                }}
              />
            </div>
            <footer className="drawerFoot">
              {canEdit ? (
                <button
                  className="btn tiny"
                  onClick={() => {
                    setMembersOpen(false);
                    setChannelModal({ mode: "edit", channel: activeChannel });
                  }}
                >
                  <Icon name="users" size={15} /> Spravovat členy
                </button>
              ) : activeChannel.visibility === "private" ? (
                <button className="btn tiny danger ghost" onClick={() => void leaveChannel()}>
                  <Icon name="logOut" size={15} /> Opustit kanál
                </button>
              ) : null}
            </footer>
          </aside>
        </div>
      )}

      {channelModal && (
        <ChannelModal
          open
          mode={channelModal.mode}
          channel={channelModal.channel}
          me={me}
          onClose={() => setChannelModal(null)}
          onSaved={(channel) => {
            if (channel) void refreshChannels(channel.id);
            else void refreshChannels();
          }}
        />
      )}

      {settingsOpen && (
        <SettingsModal
          open
          user={me}
          wsStatus={wsStatus}
          version={config.version}
          maxUploadMB={config.maxUploadMB}
          onSave={updateUser}
          onRefreshUser={refresh}
          onClose={() => setSettingsOpen(false)}
          onLogout={() => {
            if (window.confirm("Odhlásit se?")) void logout();
          }}
        />
      )}

      {pollOpen && activeChannel && (
        <PollModal
          open
          channelName={activeLabel}
          dm={isDM}
          onClose={() => setPollOpen(false)}
          onCreate={createPoll}
        />
      )}

      {pinsOpen && activeChannel && (
        <PinsPanel
          channelName={activeChannel.name}
          messages={pins}
          canPin={canPin}
          onClose={() => setPinsOpen(false)}
          onJump={(id) => void jumpToMessage(id)}
          onUnpin={(message) => void togglePin(message)}
        />
      )}

      {messagesUser && (
        <UserMessagesPanel
          user={messagesUser}
          channels={channels}
          onClose={() => setMessagesUser(null)}
          onJump={openMessageAt}
        />
      )}

      {profileUser && (
        <ProfileCard
          user={profileUser}
          me={me}
          online={online.has(profileUser.id)}
          onClose={() => setProfileUser(null)}
          onUpdated={(updated) => {
            setProfileUser(updated);
            setMembers((prev) =>
              prev.map((member) => (member.id === updated.id ? { ...member, ...updated } : member)),
            );
            if (updated.id === me.id) void refresh();
          }}
          onEditSelf={() => {
            setProfileUser(null);
            setSettingsOpen(true);
          }}
          onViewMessages={(target) => {
            setProfileUser(null);
            setMessagesUser(target);
          }}
          onMessage={(target) => void startDM(target)}
          onOpenChannel={openChannel}
        />
      )}
    </div>
  );
}
