import { useEffect, useState } from "react";
import { fileURL } from "../api";
import type { Message, Poll, User } from "../types";
import { formatDateTime, formatDuration, formatSize, formatTime } from "../utils";
import { Icon } from "./Icon";
import { Avatar } from "./ui";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🔥", "😮", "😢"];

function linkify(text: string) {
  const parts = text.split(/(https?:\/\/[^\s<]+)/g);
  return parts.map((part, index) => {
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={index} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>
      );
    }
    return <span key={index}>{part}</span>;
  });
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
}) {
  const [picker, setPicker] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const canDelete = me.id === message.user.id || me.admin;

  const jumpTo = (id: number) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("msgFlash");
      window.setTimeout(() => el.classList.remove("msgFlash"), 1200);
    }
  };

  return (
    <div
      id={`msg-${message.id}`}
      className={`message${grouped ? " grouped" : ""}${flash ? " msgFlash" : ""}${message.deleted ? " deleted" : ""}${actionsOpen ? " actionsOpen" : ""}`}
      onClick={(e) => {
        const target = e.target as HTMLElement;
        if (target.closest("button, a, video, audio, input, textarea")) return;
        setActionsOpen((open) => !open);
      }}
    >
      <div className="messageAvatar">
        {!grouped && <Avatar name={message.user.displayName} color={message.user.avatarColor} size={38} />}
      </div>
      <div className="messageMain">
        {!grouped && (
          <div className="messageHead">
            <span className="messageAuthor">{message.user.displayName}</span>
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
            {message.text && <div className="messageText">{linkify(message.text)}</div>}
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
          <button className="iconBtn" title="Reagovat" onClick={() => setPicker((v) => !v)}>
            <Icon name="smile" size={16} />
          </button>
          <button className="iconBtn" title="Odpovědět" onClick={() => onReply(message)}>
            <Icon name="reply" size={16} />
          </button>
          {canDelete && (
            <button className="iconBtn danger" title="Smazat" onClick={() => onDelete(message)}>
              <Icon name="trash" size={16} />
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
