import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Avatar } from "./ui";
import type { CallState } from "../useCall";
import type { CallPeer } from "../types";
import { formatDuration } from "../utils";

export default function CallBar({
  call,
  channelName,
  peers,
}: {
  call: {
    state: CallState | null;
    leave: () => void;
    toggleMute: () => void;
    toggleCamera: () => Promise<void>;
  };
  channelName: string;
  peers: Record<number, CallPeer>;
}) {
  const state = call.state;
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!state) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state]);

  if (!state) return null;

  const remote = [...state.remoteStreams.entries()];
  const hasCamera = state.camera;

  return (
    <div className="callBar">
      <header className="callHead">
        <span className="callPulse" />
        <div className="callTitle">
          <strong>Hovor · #{channelName}</strong>
          <span>{formatDuration((now - state.startedAt) / 1000)}</span>
        </div>
        <span className="callCount">
          <Icon name="users" size={14} /> {Object.keys(state.peers).length + 1}
        </span>
      </header>

      <div className={`callTiles${hasCamera || remote.some(([, s]) => s.getVideoTracks().length) ? " withVideo" : ""}`}>
        <div className="callTile local">
          {hasCamera && state.localStream ? (
            <video
              autoPlay
              muted
              playsInline
              ref={(el) => {
                if (el && el.srcObject !== state.localStream) el.srcObject = state.localStream;
              }}
            />
          ) : (
            <span className="callAvatarWrap">
              <span className="callAvatar" style={{ background: "#3b4a63" }}>
                Ty
              </span>
              {state.muted && <span className="mutedBadge"><Icon name="volumeOff" size={12} /></span>}
            </span>
          )}
          <span className="callName">Ty</span>
        </div>

        {remote.map(([id, stream]) => {
          const peer = peers[id];
          const video = stream.getVideoTracks().length > 0;
          return (
            <div className="callTile" key={id}>
              {video ? (
                <video
                  autoPlay
                  playsInline
                  ref={(el) => {
                    if (el && el.srcObject !== stream) el.srcObject = stream;
                  }}
                />
              ) : (
                <>
                  <audio
                    autoPlay
                    ref={(el) => {
                      if (el && el.srcObject !== stream) el.srcObject = stream;
                    }}
                  />
                  <span className="callAvatarWrap">
                    <Avatar name={peer?.displayName ?? `#${id}`} color={peer?.avatarColor ?? "#64748b"} size={54} />
                  </span>
                </>
              )}
              <span className="callName">{peer?.displayName ?? `Uživatel ${id}`}</span>
            </div>
          );
        })}
      </div>

      <div className="callControls">
        <button
          className={`callBtn${state.muted ? " off" : ""}`}
          onClick={call.toggleMute}
          title={state.muted ? "Zapnout mikrofon" : "Ztlumit mikrofon"}
        >
          <Icon name={state.muted ? "volumeOff" : "volume"} size={19} />
        </button>
        <button
          className={`callBtn${state.camera ? " active" : ""}`}
          onClick={() => void call.toggleCamera()}
          title={state.camera ? "Vypnout kameru" : "Zapnout kameru"}
        >
          <Icon name={state.camera ? "video" : "videoOff"} size={19} />
        </button>
        <button className="callBtn hangup" onClick={call.leave} title="Zavěsit">
          <Icon name="phoneOff" size={19} />
        </button>
      </div>
    </div>
  );
}
