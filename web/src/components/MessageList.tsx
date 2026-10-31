import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Message, Poll, User } from "../types";
import { dayLabel, sameDay } from "../utils";
import { Icon } from "./Icon";
import MessageItem from "./MessageItem";
import { Spinner } from "./ui";

export default function MessageList({
  messages,
  me,
  channelId,
  channelName,
  loading,
  hasMore,
  loadingOlder,
  typingNames,
  showTimestamps,
  focusId,
  onLoadOlder,
  onReact,
  onDelete,
  onEdit,
  onReply,
  onVote,
  onClosePoll,
  onProfile,
  onMention,
  canPin,
  onPin,
}: {
  messages: Message[];
  me: User;
  channelId: number;
  channelName: string;
  loading: boolean;
  hasMore: boolean;
  loadingOlder: boolean;
  typingNames: string[];
  showTimestamps: boolean;
  focusId?: number | null;
  canPin?: boolean;
  onPin?: (message: Message) => void;
  onLoadOlder: () => void;
  onReact: (message: Message, emoji: string) => void;
  onDelete: (message: Message) => void;
  onEdit: (message: Message, text: string) => Promise<void>;
  onReply: (message: Message) => void;
  onVote: (poll: Poll, optionIds: number[]) => void;
  onClosePoll: (poll: Poll) => void;
  onProfile?: (user: User) => void;
  onMention?: (username: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const restore = useRef<number | null>(null);
  const lastChannel = useRef<number | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (lastChannel.current !== channelId) {
      lastChannel.current = channelId;
      atBottom.current = true;
      restore.current = null;
      box.scrollTop = box.scrollHeight;
      return;
    }
    if (focusId) {
      const el = document.getElementById(`msg-${focusId}`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        atBottom.current = false;
        restore.current = null;
        return;
      }
    }
    if (restore.current !== null) {
      box.scrollTop = box.scrollHeight - restore.current;
      restore.current = null;
      return;
    }
    if (atBottom.current) box.scrollTop = box.scrollHeight;
  }, [messages, channelId, focusId]);

  const onScroll = () => {
    const box = boxRef.current;
    if (!box) return;
    atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    setShowJump(!atBottom.current);
    if (box.scrollTop < 140 && hasMore && !loadingOlder) {
      restore.current = box.scrollHeight - box.scrollTop;
      onLoadOlder();
    }
  };

  const byId = new Map<number, Message>();
  for (const message of messages) byId.set(message.id, message);

  const items: ReactNode[] = [];
  let previous: Message | null = null;
  for (const message of messages) {
    if (!previous || !sameDay(previous.createdAt, message.createdAt)) {
      items.push(
        <div className="dayDivider" key={`day-${message.id}`}>
          <span>{dayLabel(message.createdAt)}</span>
        </div>,
      );
    }
    const grouped =
      previous !== null &&
      sameDay(previous.createdAt, message.createdAt) &&
      previous.user.id === message.user.id &&
      message.createdAt - previous.createdAt < 5 * 60 * 1000 &&
      !message.replyTo &&
      !previous.deleted;
    items.push(
      <MessageItem
        key={message.id}
        message={message}
        me={me}
        grouped={grouped}
        showTimestamps={showTimestamps}
        replyMessage={message.replyTo ? byId.get(message.replyTo) : undefined}
        flash={message.id === focusId}
        onReact={onReact}
        onDelete={onDelete}
        onEdit={onEdit}
        onReply={onReply}
        onVote={onVote}
        onClosePoll={onClosePoll}
        onProfile={onProfile}
        onMention={onMention}
        canPin={canPin}
        onPin={onPin}
      />,
    );
    previous = message;
  }

  return (
    <div className="messageList" ref={boxRef} onScroll={onScroll}>
      {loadingOlder && (
        <div className="historyLoader">
          <Spinner size={18} /> Načítám starší zprávy…
        </div>
      )}
      {!hasMore && messages.length > 0 && (
        <div className="historyStart">
          <Icon name="hash" size={15} /> Začátek kanálu <strong>#{channelName}</strong>
        </div>
      )}
      {loading ? (
        <div className="messageLoading">
          <Spinner size={26} />
        </div>
      ) : messages.length === 0 ? (
        <div className="emptyChat">
          <div className="emptyChatIcon">
            <Icon name="hash" size={30} />
          </div>
          <h3>Vítej v #{channelName}</h3>
          <p>Zatím tu nic není. Napiš první zprávu, pošli hlasovku nebo založ anketu.</p>
        </div>
      ) : (
        items
      )}
      {typingNames.length > 0 && (
        <div className="typingRow">
          <span className="typingDots">
            <i />
            <i />
            <i />
          </span>
          {typingNames.length === 1 ? `${typingNames[0]} píše…` : `${typingNames.join(", ")} píšou…`}
        </div>
      )}
      <div className="messageAnchor" />
      {showJump && messages.length > 0 && (
        <button
          type="button"
          className="jumpToBottom"
          onClick={() => {
            const box = boxRef.current;
            if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
            setShowJump(false);
          }}
        >
          <Icon name="chevron" size={16} /> Nejnovější
        </button>
      )}
    </div>
  );
}
