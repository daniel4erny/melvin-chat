import type { ChannelMember, User } from "../types";
import { Icon } from "./Icon";
import { Avatar } from "./ui";

type Props = {
  members: ChannelMember[];
  online: Set<number>;
  me: User;
  callIds?: Set<number>;
  recordingIds?: Set<number>;
  onProfile: (user: User) => void;
  channelName?: string;
};

function MemberRow({
  member,
  online,
  me,
  inCall,
  recording,
  onProfile,
}: {
  member: ChannelMember;
  online: boolean;
  me: User;
  inCall: boolean;
  recording: boolean;
  onProfile: (user: User) => void;
}) {
  const timeoutActive = Boolean(member.timeoutUntil && member.timeoutUntil > Date.now());
  return (
    <button type="button" className={`memberRow${online ? "" : " offline"}`} onClick={() => onProfile(member)}>
      <Avatar
        name={member.displayName}
        color={member.avatarColor}
        avatarId={member.avatarId}
        size={34}
        online={online}
        ring={inCall}
      />
      <span className="memberRowInfo">
        <span className="memberRowTop">
          <strong style={{ color: member.avatarColor }}>
            {member.displayName}
            {member.id === me.id && <span className="selfMark">ty</span>}
          </strong>
          {member.role === "owner" && <span className="roleCrown" title="Vlastník kanálu">★</span>}
          {member.admin && <span className="miniBadge admin" title="Admin">ADMIN</span>}
          {timeoutActive && (
            <span className="miniBadge timeout" title={member.timeoutReason || "Timeout"}>
              TIMEOUT
            </span>
          )}
          {member.banned && (
            <span className="miniBadge ban" title={member.banReason || "Ban"}>
              BAN
            </span>
          )}
        </span>
        <span className="memberRowSub">
          {inCall && (
            <span className="memberCallTag">
              <Icon name="phone" size={11} /> v hovoru
            </span>
          )}
          {recording && (
            <span className="memberCallTag rec">
              <span className="recordDot tiny" /> nahrává
            </span>
          )}
          {member.statusEmoji || member.statusText ? (
            <span className="memberStatusLine">
              {member.statusEmoji} {member.statusText}
            </span>
          ) : (
            <span className="memberHandle">@{member.username}</span>
          )}
        </span>
      </span>
    </button>
  );
}

export default function MemberList({
  members,
  online,
  me,
  callIds,
  recordingIds,
  onProfile,
  channelName,
}: Props) {
  const inCall = members.filter((member) => callIds?.has(member.id));
  const onlineMembers = members.filter((member) => online.has(member.id) && !callIds?.has(member.id));
  const offlineMembers = members.filter((member) => !online.has(member.id));

  const section = (title: string, list: ChannelMember[]) =>
    list.length > 0 && (
      <div className="memberGroup" key={title}>
        <div className="memberGroupHead">
          {title} — {list.length}
        </div>
        {list.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            online={online.has(member.id)}
            me={me}
            inCall={Boolean(callIds?.has(member.id))}
            recording={Boolean(recordingIds?.has(member.id))}
            onProfile={onProfile}
          />
        ))}
      </div>
    );

  return (
    <div className="memberListV2">
      {channelName && <div className="memberListHint">#{channelName}</div>}
      {section("Ve hovoru", inCall)}
      {section("Online", onlineMembers)}
      {section("Offline", offlineMembers)}
      {members.length === 0 && <p className="muted small">Načítám členy…</p>}
    </div>
  );
}
