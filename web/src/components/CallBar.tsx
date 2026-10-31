import { useEffect, useState } from "react";
import { useAuth } from "../auth";
import type { CallPeer } from "../types";
import { formatDuration } from "../utils";
import type { CallState } from "../useCall";
import { Icon } from "./Icon";
import { Avatar } from "./ui";

type CallController = {
  state: CallState | null;
  leave: () => void;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
  toggleDeafen: () => void;
  toggleScreen: () => Promise<void>;
};

function useDuration(startedAt?: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt ? Math.max(0, (now - startedAt) / 1000) : 0;
}

function RemoteTile({
  peer,
  stream,
  deafened,
}: {
  peer?: CallPeer;
  stream: MediaStream;
  deafened: boolean;
}) {
  const [hasVideo, setHasVideo] = useState(stream.getVideoTracks().length > 0);

  useEffect(() => {
    const update = () =>
      setHasVideo(stream.getVideoTracks().some((track) => track.readyState === "live"));
    update();
    stream.addEventListener("addtrack", update);
    stream.addEventListener("removetrack", update);
    const timer = window.setInterval(update, 1500);
    return () => {
      stream.removeEventListener("addtrack", update);
      stream.removeEventListener("removetrack", update);
      window.clearInterval(timer);
    };
  }, [stream]);

  return (
    <div className={`callTileV2${hasVideo ? " hasVideo" : ""}`}>
      {hasVideo ? (
        <video
          autoPlay
          playsInline
          muted={deafened}
          ref={(el) => {
            if (el && el.srcObject !== stream) el.srcObject = stream;
          }}
        />
      ) : (
        <>
          <audio
            autoPlay
            muted={deafened}
            ref={(el) => {
              if (el && el.srcObject !== stream) el.srcObject = stream;
            }}
          />
          <Avatar
            name={peer?.displayName ?? "Uživatel"}
            color={peer?.avatarColor ?? "#64748b"}
            avatarId={peer?.avatarId}
            size={96}
          />
        </>
      )}
      <span className="callTileName">
        {peer?.displayName ?? "Uživatel"}
        {peer?.muted && (
          <span className="callMicBadge">
            <Icon name="volumeOff" size={12} />
          </span>
        )}
      </span>
    </div>
  );
}

export default function CallBar({
  call,
  channelName,
  peers,
}: {
  call: CallController;
  channelName: string;
  peers: Record<number, CallPeer>;
}) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState(false);
  const state = call.state;
  const duration = useDuration(state?.startedAt);

  if (!state) return null;

  const remote = [...state.remoteStreams.entries()];
  const count = remote.length + 1;
  const peerList = Object.values(peers).filter((peer) => peer.id !== user?.id);

  const controls = (
    <div className="callControlsV2">
      <button
        className={`callControl${state.muted ? " off" : ""}`}
        onClick={call.toggleMute}
        title={state.muted ? "Zapnout mikrofon" : "Ztlumit mikrofon"}
        aria-label={state.muted ? "Zapnout mikrofon" : "Ztlumit mikrofon"}
      >
        <Icon name={state.muted ? "volumeOff" : "mic"} size={18} />
      </button>
      <button
        className={`callControl${state.deafened ? " off" : ""}`}
        onClick={call.toggleDeafen}
        title={state.deafened ? "Zrušit ztlumení zvuku" : "Ztlumit zvuk"}
        aria-label={state.deafened ? "Zrušit ztlumení zvuku" : "Ztlumit zvuk"}
      >
        <Icon name="headphones" size={18} />
      </button>
      <button
        className={`callControl${state.camera ? " active" : ""}`}
        onClick={() => void call.toggleCamera()}
        disabled={state.screen}
        title={state.camera ? "Vypnout kameru" : "Zapnout kameru"}
        aria-label={state.camera ? "Vypnout kameru" : "Zapnout kameru"}
      >
        <Icon name={state.camera ? "video" : "videoOff"} size={18} />
      </button>
      <button
        className={`callControl${state.screen ? " active" : ""}`}
        onClick={() => void call.toggleScreen()}
        title={state.screen ? "Ukončit sdílení" : "Sdílet obrazovku"}
        aria-label={state.screen ? "Ukončit sdílení" : "Sdílet obrazovku"}
      >
        <Icon name="monitor" size={18} />
      </button>
      <button className="callControl hangup" onClick={call.leave} title="Zavěsit" aria-label="Zavěsit">
        <Icon name="phoneOff" size={18} />
      </button>
    </div>
  );

  const localTile = (
    <div className={`callTileV2 local${state.camera || state.screen ? " hasVideo" : ""}`}>
      {state.camera || state.screen ? (
        <video
          autoPlay
          muted
          playsInline
          ref={(el) => {
            if (el && el.srcObject !== state.localStream) el.srcObject = state.localStream;
          }}
        />
      ) : (
        <Avatar
          name={user?.displayName ?? "Ty"}
          color={user?.avatarColor ?? "#5865f2"}
          avatarId={user?.avatarId}
          size={96}
        />
      )}
      <span className="callTileName">
        {user?.displayName ?? "Ty"} (ty)
        {state.muted && (
          <span className="callMicBadge">
            <Icon name="volumeOff" size={12} />
          </span>
        )}
        {state.screen && (
          <span className="callMicBadge">
            <Icon name="monitor" size={12} />
          </span>
        )}
      </span>
    </div>
  );

  if (!expanded) {
    return (
      <div className="callDock">
        <span className="callDockPulse" />
        <div className="callDockInfo">
          <strong>#{channelName}</strong>
          <span>
            {formatDuration(duration)} · {count} {count === 1 ? "účastník" : count < 5 ? "účastníci" : "účastníků"}
          </span>
        </div>
        <div className="callDockPeople">
          {user && (
            <Avatar
              name={user.displayName}
              color={user.avatarColor}
              avatarId={user.avatarId}
              size={24}
              ring={!state.muted}
            />
          )}
          {peerList.slice(0, 2).map((peer) => (
            <Avatar
              key={peer.id}
              name={peer.displayName}
              color={peer.avatarColor}
              avatarId={peer.avatarId}
              size={24}
              ring={!peer.muted}
            />
          ))}
          {peerList.length > 2 && <span className="callDockMore">+{peerList.length - 2}</span>}
        </div>
        {controls}
        <button className="callDockExpand" onClick={() => setExpanded(true)} title="Zvětšit hovor" aria-label="Zvětšit hovor">
          <Icon name="chevron" size={16} />
        </button>
      </div>
    );
  }

  return (
    <div className="callStageBackdrop">
      <div className="callStage">
        <header className="callStageHead">
          <span className="callDockPulse" />
          <div>
            <strong>Hovor · #{channelName}</strong>
            <span>
              {formatDuration(duration)} · {count} {count === 1 ? "účastník" : count < 5 ? "účastníci" : "účastníků"}
            </span>
          </div>
          {state.screen && (
            <span className="callStageTag">
              <Icon name="monitor" size={13} /> sdílíš obrazovku
            </span>
          )}
          <button className="iconBtn callStageClose" onClick={() => setExpanded(false)} aria-label="Zmenšit hovor">
            <Icon name="chevron" size={18} />
          </button>
        </header>

        <div className={`callGrid${remote.length > 3 ? " many" : ""}`}>
          {localTile}
          {remote.map(([id, stream]) => (
            <RemoteTile key={id} peer={peers[id]} stream={stream} deafened={state.deafened} />
          ))}
        </div>

        {remote.length === 0 && (
          <p className="callWaitHint">
            <span className="typingDots">
              <i />
              <i />
              <i />
            </span>
            Čekám, až se někdo přidá…
          </p>
        )}

        <footer className="callStageFoot">{controls}</footer>
      </div>
    </div>
  );
}
