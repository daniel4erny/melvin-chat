import { useEffect, useState } from "react";
import { api } from "../api";
import type { Channel, Message, User } from "../types";
import { formatDateTime, plural } from "../utils";
import { Icon } from "./Icon";
import { Avatar, SidePanel, Spinner } from "./ui";

function snippet(message: Message): string {
  if (message.deleted) return "smazaná zpráva";
  if (message.text.trim()) return message.text.trim();
  if (message.poll) return `Anketa: ${message.poll.question}`;
  if (message.sticker) return message.sticker.emoji ? `Stiker ${message.sticker.emoji}` : "Stiker";
  if (message.attachment) {
    const att = message.attachment;
    if (att.kind === "voice") return "Hlasovka";
    if (att.kind === "image") return `Fotka · ${att.name}`;
    if (att.kind === "video") return `Video · ${att.name}`;
    return att.name;
  }
  return "zpráva";
}

export default function UserMessagesPanel({
  user,
  channels,
  onClose,
  onJump,
}: {
  user: User;
  channels: Channel[];
  onClose: () => void;
  onJump: (channelId: number, messageId: number) => void;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api<{ messages: Message[]; hasMore: boolean }>(`/api/users/${user.id}/messages?limit=50`)
      .then((res) => {
        if (cancelled) return;
        setMessages(res.messages);
        setHasMore(res.hasMore);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Zprávy se nepodařilo načíst");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const loadMore = async () => {
    if (loadingMore || !hasMore || messages.length === 0) return;
    setLoadingMore(true);
    try {
      const last = messages[messages.length - 1]!;
      const res = await api<{ messages: Message[]; hasMore: boolean }>(
        `/api/users/${user.id}/messages?limit=50&before=${last.id}`,
      );
      setMessages((prev) => [...prev, ...res.messages]);
      setHasMore(res.hasMore);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Další zprávy se nepodařilo načíst");
    } finally {
      setLoadingMore(false);
    }
  };

  const channelName = (id: number) => channels.find((channel) => channel.id === id)?.name ?? "kanál";

  return (
    <SidePanel
      open
      onClose={onClose}
      title={
        <span className="panelTitleWithAvatar">
          <Avatar name={user.displayName} color={user.avatarColor} avatarId={user.avatarId} size={30} />
          Zprávy · {user.displayName}
        </span>
      }
      subtitle={`${messages.length}${hasMore ? "+" : ""} ${plural(messages.length, "zpráva", "zprávy", "zpráv")} ve společných kanálech`}
      footer={
        hasMore ? (
          <button className="btn ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? <Spinner size={15} /> : <Icon name="chevron" size={15} />} Načíst další
          </button>
        ) : undefined
      }
    >
      {loading && (
        <div className="panelLoading">
          <Spinner size={20} /> Načítám zprávy…
        </div>
      )}
      {error && <p className="searchHint error">{error}</p>}
      {!loading && !error && messages.length === 0 && (
        <div className="panelEmpty">
          <Icon name="search" size={26} />
          <h4>Žádné zprávy</h4>
          <p>V kanálech, které vidíš ty i {user.displayName}, zatím nic nenapsal(a).</p>
        </div>
      )}
      <div className="userMessageList">
        {messages.map((message) => (
          <button
            key={message.id}
            type="button"
            className="userMessageRow"
            onClick={() => onJump(message.channelId, message.id)}
          >
            <span className="userMessageChannel">
              <Icon name={channels.find((c) => c.id === message.channelId)?.visibility === "private" ? "lock" : "hash"} size={12} />
              {channelName(message.channelId)}
              <time>{formatDateTime(message.createdAt)}</time>
            </span>
            <span className="userMessageText">{snippet(message)}</span>
            {message.pinned && (
              <span className="pinnedMini">
                <Icon name="pin" size={11} /> připnuto
              </span>
            )}
          </button>
        ))}
      </div>
    </SidePanel>
  );
}
