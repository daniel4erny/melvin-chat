import type { Message } from "../types";
import { formatDateTime } from "../utils";
import { Icon } from "./Icon";
import { Avatar, SidePanel } from "./ui";

export default function PinsPanel({
  channelName,
  messages,
  canPin,
  onClose,
  onJump,
  onUnpin,
}: {
  channelName: string;
  messages: Message[];
  canPin: boolean;
  onClose: () => void;
  onJump: (messageId: number) => void;
  onUnpin: (message: Message) => void;
}) {
  return (
    <SidePanel
      open
      onClose={onClose}
      title={
        <span className="panelTitleWithAvatar">
          <Icon name="pin" size={17} /> Připnuté zprávy
        </span>
      }
      subtitle={`#${channelName} · ${messages.length}`}
    >
      {messages.length === 0 ? (
        <div className="panelEmpty">
          <Icon name="pin" size={26} />
          <h4>Nic tu není připnuté</h4>
          <p>Vlastník kanálu nebo admin může připnout důležitou zprávu v menu u zprávy.</p>
        </div>
      ) : (
        <div className="pinList">
          {messages.map((message) => (
            <div key={message.id} className="pinRow">
              <button type="button" className="pinRowMain" onClick={() => onJump(message.id)}>
                <span className="pinRowHead">
                  <Avatar
                    name={message.user.displayName}
                    color={message.user.avatarColor}
                    avatarId={message.user.avatarId}
                    size={22}
                  />
                  <strong>{message.user.displayName}</strong>
                  <time>{formatDateTime(message.createdAt)}</time>
                </span>
                <span className="pinRowText">
                  {message.text || message.attachment?.name || message.poll?.question || "zpráva"}
                </span>
              </button>
              {canPin && (
                <button
                  className="iconBtn"
                  title="Odepnout"
                  aria-label="Odepnout zprávu"
                  onClick={() => onUnpin(message)}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </SidePanel>
  );
}
