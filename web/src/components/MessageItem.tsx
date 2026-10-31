import { useEffect, useRef, useState, type ReactNode } from "react";
import { fileURL } from "../api";
import { toast } from "../toast";
import type { Message, Poll, User } from "../types";
import { formatDateTime, formatDuration, formatSize, formatTime } from "../utils";
import { Icon } from "./Icon";
import { Avatar } from "./ui";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "😮", "😢"];

const URL_RE = /(https?:\/\/[^\s<]+)/g;
const MENTION_RE = /(@[a-zA-Z0-9_.-]{3,24})/g;

function renderText(text: string, onMention?: (username: string) => void): ReactNode[] {
  const out: ReactNode[] = [];
  const urlParts = text.split(URL_RE);
  urlParts.forEach((part, urlIndex) => {
    if (/^https?:\/\//.test(part)) {
      out.push(
        <a key={`u${urlIndex}`} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>,
      );
      return;
    }
    const pieces = part.split(MENTION_RE);
    pieces.forEach((piece, pieceIndex) => {
      if (/^@[a-zA-Z0-9_.-]{3,24}$/.test(piece)) {
        out.push(
          <button
            type="button"
            key={`m${urlIndex}-${pieceIndex}`}
            className="mention"
            onClick={(event) => {
              event.stopPropagation();
              onMention?.(piece.slice(1));
            }}
          >
            {piece}
          </button>,
        );
      } else if (piece) {
        out.push(<span key={`t${urlIndex}-${pieceIndex}`}>{piece}</span>);
      }
    });
  });
  return out;
}

function PollCard({
  poll,
  me,
  onVote,
  onClose,
}: {
  poll: Poll;
  me: User;
  onVote: (poll: Poll, optionIds: number[]) => void;
  onClose: (poll: Poll) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set(poll.myVotes));

  useEffect(() => {
    setSelected(new Set(poll.myVotes));
  }, [poll.id, poll.myVotes]);

  const canClose = (me.id === poll.creatorId || me.admin) && !poll.closed;

  const toggle = (optionId: number) => {
    if (poll.closed) return;
    if (!poll.multi) {
      onVote(poll, poll.myVotes.includes(optionId) ? [] : [optionId]);
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      return next;
    });
  };

  return (
    <div className={`pollCard${poll.closed ? " closed" : ""}`}>
      <div className="pollTop">
        <span className="pollIcon">
          <Icon name="poll" size={16} />
        </span>
        <div>
          <h4>{poll.question}</h4>
          <div className="pollMeta">
            {poll.multi && <span>více odpovědí</span>}
            {poll.anonymous && <span>anonymní</span>}
            {poll.closed && <span className="closedTag">uzavřeno</span>}
          </div>
        </div>
      </div>
      <div className="pollOptions">
        {poll.options.map((option) => {
          const mine = poll.myVotes.includes(option.id) || selected.has(option.id);
          const percent = poll.totalVotes > 0 ? Math.round((option.votes / poll.totalVotes) * 100) : 0;
          return (
            <button
              key={option.id}
              className={`pollOption${mine ? " mine" : ""}${poll.closed ? " locked" : ""}`}
              onClick={() => toggle(option.id)}
              disabled={poll.closed}
            >
              <span className="pollBar" style={{ width: `${percent}%` }} />
              <span className="pollText">
                {mine ? <Icon name="check" size={14} /> : <span className="pollDot" />}
                {option.text}
              </span>
              <span className="pollVotes">
                {option.votes} · {percent}%
              </span>
            </button>
          );
        })}
      </div>
      <div className="pollFoot">
        <span>{poll.totalVotes} hlasů</span>
        <div className="row gap">
          {poll.multi && !poll.closed && (
            <button className="btn tiny" onClick={() => onVote(poll, [...selected])}>
              Hlasovat
            </button>
          )}
          {canClose && (
            <button className="btn tiny ghost" onClick={() => onClose(poll)}>
              Uzavřít anketu
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function AttachmentView({ message }: { message: Message }) {
  const att = message.attachment;
  if (!att) return null;
  const url = fileURL(att.id);

  if (att.kind === "image") {
    return (
      <a className="imageAttachment" href={url} target="_blank" rel="noreferrer noopener">
        <img src={url} alt={att.name} loading="lazy" />
        <span className="attachmentCaption">{att.name}</span>
      </a>
    );
  }

  if (att.kind === "video") {
    return (
      <div className="videoAttachment">
        <video src={url} controls preload="metadata" playsInline />
        <span className="attachmentCaption">{att.name}</span>
      </div>
    );
  }

  if (att.kind === "voice") {
    return (
      <div className="voiceAttachment">
        <span className="voiceIcon">
          <Icon name="mic" size={16} />
        </span>
        <audio src={url} controls preload="metadata" />
        <span className="voiceDuration">{att.duration ? formatDuration(att.duration) : ""}</span>
      </div>
    );
  }

  if (att.kind === "audio") {
    return (
      <div className="voiceAttachment">
        <span className="voiceIcon">
          <Icon name="volume" size={16} />
        </span>
        <audio src={url} controls preload="metadata" />
        <span className="voiceDuration">{att.name}</span>
      </div>
    );
  }

  return (
    <a className="fileAttachment" href={url} download={att.name} target="_blank" rel="noreferrer noopener">
      <span className="fileIcon">
        <Icon name="file" size={20} />
      </span>
      <span className="fileInfo">
        <strong>{att.name}</strong>
        <small>{formatSize(att.size)}</small>
      </span>
      <Icon name="download" size={18} />
    </a>
  );
}

export default function MessageItem({
  message,
  me,
  grouped,
  showTimestamps,
  replyMessage,
  flash,
  onReact,
  onDelete,
  onReply,
  onVote,
  onClosePoll,
  onProfile,
  onMention,
}: {
  message: Message;
  me: User;
  grouped: boolean;
  showTimestamps: boolean;
  replyMessage?: Message;
  flash: boolean;
  onReact: (message: Message, emoji: string) => void;
  onDelete: (message: Message) => void;
  onReply: (message: Message) => void;
  onVote: (poll: Poll, optionIds: number[]) => void;
  onClosePoll: (poll: Poll) => void;
  onProfile?: (user: User) => void;
  onMention?: (username: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [touchActive, setTouchActive] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const canDelete = me.id === message.user.id || me.admin;

  useEffect(() => {
    if (!menuOpen && !touchActive) return;
    const onDocDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setTouchActive(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setTouchActive(false);
      }
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, touchActive]);

  const onMessageClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!window.matchMedia("(max-width: 900px)").matches) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, audio, video, input, textarea")) return;
    setTouchActive((active) => !active);
  };

  const jumpTo = (id: number) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msgFlash");
      window.setTimeout(() => el.classList.remove("msgFlash"), 1200);
    }
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(message.text);
      toast.success("Text zkopírován");
    } catch {
      toast.error("Kopírování se nepovedlo");
    }
    setMenuOpen(false);
  };

  return (
    <div
      id={`msg-${message.id}`}
      ref={rootRef}
      onClick={onMessageClick}
      className={`message${grouped ? " grouped" : ""}${flash ? " msgFlash" : ""}${message.deleted ? " deleted" : ""}${menuOpen || touchActive ? " actionsOpen" : ""}`}
    >
      <div className="messageAvatar">
        {!grouped && (
          <button
            type="button"
            className="avatarBtn"
            onClick={() => onProfile?.(message.user)}
            aria-label={`Profil ${message.user.displayName}`}
          >
            <Avatar name={message.user.displayName} color={message.user.avatarColor} size={38} />
          </button>
        )}
      </div>
      <div className="messageMain">
        {!grouped && (
          <div className="messageHead">
            <button type="button" className="messageAuthor" onClick={() => onProfile?.(message.user)}>
              {message.user.displayName}
            </button>
            {message.user.admin && <span className="adminTag">admin</span>}
            {showTimestamps && (
              <time className="messageTime" title={formatDateTime(message.createdAt)}>
                {formatTime(message.createdAt)}
              </time>
            )}
            {message.editedAt && <span className="editedTag">upraveno</span>}
          </div>
        )}

        {replyMessage && (
          <button className="replyQuote" onClick={() => jumpTo(replyMessage.id)}>
            <Icon name="reply" size={12} />
            <strong>{replyMessage.user.displayName}</strong>
            <span>{replyMessage.text || replyMessage.attachment?.name || "zpráva"}</span>
          </button>
        )}

        {message.deleted ? (
          <p className="deletedText">Tato zpráva byla smazána.</p>
        ) : (
          <>
            {message.text && <div className="messageText">{renderText(message.text, onMention)}</div>}
            <AttachmentView message={message} />
            {message.poll && (
              <PollCard poll={message.poll} me={me} onVote={onVote} onClose={onClosePoll} />
            )}
          </>
        )}

        {!message.deleted && message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((reaction) => (
              <button
                key={reaction.emoji}
                className={`reaction${reaction.mine ? " mine" : ""}`}
                onClick={() => onReact(message, reaction.emoji)}
                title={`${reaction.count}× ${reaction.emoji}`}
              >
                {reaction.emoji} <span>{reaction.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {!message.deleted && (
        <div className="messageActions">
          <button
            className={`iconBtn${menuOpen ? " active" : ""}`}
            title="Další akce"
            aria-label="Další akce"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="more" size={18} />
          </button>
        </div>
      )}

      {menuOpen && !message.deleted && (
        <div className="msgMenu" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setPicker(true);
            }}
          >
            <Icon name="smile" size={16} /> Reagovat
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              onReply(message);
            }}
          >
            <Icon name="reply" size={16} /> Odpovědět
          </button>
          {message.text && (
            <button role="menuitem" onClick={() => void copyText()}>
              <Icon name="copy" size={16} /> Kopírovat text
            </button>
          )}
          {canDelete && (
            <button
              role="menuitem"
              className="danger"
              onClick={() => {
                setMenuOpen(false);
                onDelete(message);
              }}
            >
              <Icon name="trash" size={16} /> Smazat
            </button>
          )}
        </div>
      )}

      {picker && (
        <div className="emojiPop messageEmojiPop">
          {QUICK_REACTIONS.map((emoji) => (
            <button
              key={emoji}
              onClick={() => {
                onReact(message, emoji);
                setPicker(false);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
