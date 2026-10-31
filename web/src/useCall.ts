import { useCallback, useEffect, useRef, useState } from "react";
import { socket, type SocketEvent } from "./ws";
import type { AppConfig, CallPeer } from "./types";
import { toast } from "./toast";
import { logEvent } from "./logs";

export type CallState = {
  channelId: number;
  peers: Record<number, CallPeer>;
  muted: boolean;
  camera: boolean;
  startedAt: number;
  localStream: MediaStream | null;
  remoteStreams: Map<number, MediaStream>;
};

type Call = {
  state: CallState | null;
  join: (channelId: number) => Promise<void>;
  leave: () => void;
  toggleMute: () => void;
  toggleCamera: () => Promise<void>;
  handleEvent: (event: SocketEvent) => void;
};

export function useCall(config: AppConfig | null): Call {
  const [state, setState] = useState<CallState | null>(null);
  const stateRef = useRef<CallState | null>(null);
  const pcs = useRef(new Map<number, RTCPeerConnection>());
  const pendingIce = useRef(new Map<number, RTCIceCandidateInit[]>());
  const pendingOffers = useRef(new Map<number, Promise<void>>());

  const commit = useCallback((next: CallState | null) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const iceServers = useCallback((): RTCIceServer[] => {
    const entries = config?.iceServers?.length ? config.iceServers : ["stun:stun.l.google.com:19302"];
    return entries.map((entry) => {
      // "turn:host:3478|username|password"
      const [url, username, credential] = entry.split("|");
      if (url && username && credential) return { urls: url, username, credential };
      return { urls: entry };
    });
  }, [config]);

  const send = useCallback((payload: Record<string, unknown>) => {
    if (!socket.send(payload)) {
      logEvent("warn", "Signál se nepodařilo odeslat – socket je offline");
    }
  }, []);

  const closePeer = useCallback((userId: number) => {
    const pc = pcs.current.get(userId);
    if (pc) {
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.close();
      pcs.current.delete(userId);
    }
    pendingIce.current.delete(userId);
    pendingOffers.current.delete(userId);
    const current = stateRef.current;
    if (!current) return;
    const peers = { ...current.peers };
    delete peers[userId];
    const streams = new Map(current.remoteStreams);
    streams.delete(userId);
    commit({ ...current, peers, remoteStreams: streams });
  }, [commit]);

  const createPeer = useCallback(
    (peer: CallPeer): RTCPeerConnection | null => {
      const current = stateRef.current;
      if (!current) return null;
      const existing = pcs.current.get(peer.id);
      if (existing) return existing;
      const pc = new RTCPeerConnection({ iceServers: iceServers() });
      pcs.current.set(peer.id, pc);
      const local = current.localStream;
      if (local) {
        for (const track of local.getTracks()) pc.addTrack(track, local);
      }
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          send({
            type: "call:ice",
            channelId: current.channelId,
            to: peer.id,
            candidate: event.candidate.toJSON(),
          });
        }
      };
      pc.ontrack = (event) => {
        const latest = stateRef.current;
        if (!latest) return;
        let stream = event.streams[0];
        if (!stream) {
          const old = latest.remoteStreams.get(peer.id);
          stream = old ?? new MediaStream();
          if (!stream.getTracks().some((t) => t.id === event.track.id)) stream.addTrack(event.track);
        }
        const streams = new Map(latest.remoteStreams);
        streams.set(peer.id, stream);
        commit({ ...latest, remoteStreams: streams });
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "failed") {
          logEvent("warn", `WebRTC spojení s ${peer.displayName} selhalo`);
          closePeer(peer.id);
        }
      };
      const latest = stateRef.current;
      if (latest) {
        commit({ ...latest, peers: { ...latest.peers, [peer.id]: peer } });
      }
      return pc;
    },
    [closePeer, commit, iceServers, send],
  );

  const makeOffer = useCallback(
    async (peerId: number, renegotiate: boolean) => {
      const current = stateRef.current;
      const pc = pcs.current.get(peerId);
      if (!current || !pc) return;
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        send({
          type: "call:offer",
          channelId: current.channelId,
          to: peerId,
          sdp: pc.localDescription?.toJSON(),
          renegotiate,
        });
      } catch (err) {
        logEvent("error", "Nepodařilo se vytvořit offer", err);
      }
    },
    [send],
  );

  const renegotiate = useCallback(async () => {
    for (const peerId of pcs.current.keys()) {
      await makeOffer(peerId, true);
    }
  }, [makeOffer]);

  const join = useCallback(
    async (channelId: number) => {
      if (stateRef.current) {
        // switching calls – hang up the old one first
        send({ type: "call:leave", channelId: stateRef.current.channelId });
        for (const id of [...pcs.current.keys()]) closePeer(id);
        stateRef.current.localStream?.getTracks().forEach((t) => t.stop());
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: false,
        });
        const next: CallState = {
          channelId,
          peers: {},
          muted: false,
          camera: false,
          startedAt: Date.now(),
          localStream: stream,
          remoteStreams: new Map(),
        };
        commit(next);
        send({ type: "call:join", channelId });
      } catch (err) {
        logEvent("error", "Mikrofon nedostupný", err);
        toast.error("Nepodařilo se zapnout mikrofon. Povol přístup k mikrofonu v prohlížeči/aplikaci.");
      }
    },
    [closePeer, commit, send],
  );

  const leave = useCallback(() => {
    const current = stateRef.current;
    if (current) send({ type: "call:leave", channelId: current.channelId });
    for (const id of [...pcs.current.keys()]) closePeer(id);
    current?.localStream?.getTracks().forEach((track) => track.stop());
    commit(null);
  }, [closePeer, commit, send]);

  const toggleMute = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;
    const enabled = current.localStream?.getAudioTracks().every((t) => t.enabled) ?? true;
    current.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !enabled;
    });
    commit({ ...current, muted: enabled });
  }, [commit]);

  const toggleCamera = useCallback(async () => {
    const current = stateRef.current;
    if (!current) return;
    if (current.camera) {
      const videoTracks = current.localStream?.getVideoTracks() ?? [];
      for (const pc of pcs.current.values()) {
        for (const sender of pc.getSenders()) {
          if (sender.track?.kind === "video") {
            try {
              pc.removeTrack(sender);
            } catch {
              // already removed
            }
          }
        }
      }
      videoTracks.forEach((track) => {
        track.stop();
        current.localStream?.removeTrack(track);
      });
      commit({ ...current, camera: false, localStream: current.localStream });
      await renegotiate();
      return;
    }
    try {
      const video = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const track = video.getVideoTracks()[0];
      if (!track) return;
      const stream = current.localStream ?? new MediaStream();
      stream.addTrack(track);
      for (const pc of pcs.current.values()) {
        pc.addTrack(track, stream);
      }
      commit({ ...current, camera: true, localStream: stream });
      await renegotiate();
    } catch (err) {
      logEvent("error", "Kamera nedostupná", err);
      toast.error("Nepodařilo se zapnout kameru. Povol přístup ke kameře.");
    }
  }, [commit, renegotiate]);

  const handleEvent = useCallback(
    (event: SocketEvent) => {
      const current = stateRef.current;
      if (!current) return;
      if (event.channelId !== current.channelId) return;

      switch (event.type) {
        case "call:participants": {
          for (const peer of event.participants ?? []) {
            const pc = createPeer(peer);
            if (pc) {
              const pending = pendingOffers.current.get(peer.id);
              if (!pending) {
                const promise = makeOffer(peer.id, false);
                pendingOffers.current.set(peer.id, promise);
                void promise.finally(() => pendingOffers.current.delete(peer.id));
              }
            }
          }
          break;
        }
        case "call:peer-joined": {
          if (event.user) createPeer(event.user);
          break;
        }
        case "call:offer": {
          if (!event.from || !event.sdp) return;
          const from = event.from;
          const sdp = event.sdp;
          const pc = createPeer(from);
          if (!pc) return;
          void (async () => {
            try {
              if (pc.signalingState === "have-local-offer") {
                await pc.setLocalDescription({ type: "rollback" });
              }
              await pc.setRemoteDescription(sdp);
              const candidateQueue = pendingIce.current.get(from.id);
              if (candidateQueue) {
                for (const candidate of candidateQueue) {
                  await pc.addIceCandidate(candidate).catch(() => undefined);
                }
                pendingIce.current.delete(from.id);
              }
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              send({
                type: "call:answer",
                channelId: current.channelId,
                to: from.id,
                sdp: pc.localDescription?.toJSON(),
                renegotiate: event.renegotiate ?? false,
              });
            } catch (err) {
              logEvent("error", "WebRTC offer selhal", err);
            }
          })();
          break;
        }
        case "call:answer": {
          if (!event.from || !event.sdp) return;
          const pc = pcs.current.get(event.from.id);
          if (!pc || pc.signalingState !== "have-local-offer") return;
          void pc
            .setRemoteDescription(event.sdp)
            .then(async () => {
              const queue = pendingIce.current.get(event.from!.id);
              if (queue) {
                for (const candidate of queue) {
                  await pc.addIceCandidate(candidate).catch(() => undefined);
                }
                pendingIce.current.delete(event.from!.id);
              }
            })
            .catch((err) => logEvent("error", "WebRTC answer selhal", err));
          break;
        }
        case "call:ice": {
          if (!event.from || !event.candidate) return;
          const pc = pcs.current.get(event.from.id);
          if (!pc) return;
          if (!pc.remoteDescription) {
            const queue = pendingIce.current.get(event.from.id) ?? [];
            queue.push(event.candidate);
            pendingIce.current.set(event.from.id, queue);
            return;
          }
          void pc.addIceCandidate(event.candidate).catch(() => undefined);
          break;
        }
        case "call:peer-left": {
          if (event.userId) closePeer(event.userId);
          break;
        }
      }
    },
    [closePeer, createPeer, makeOffer, send],
  );

  useEffect(() => {
    return () => {
      const current = stateRef.current;
      if (current) socket.send({ type: "call:leave", channelId: current.channelId });
      for (const pc of pcs.current.values()) pc.close();
      pcs.current.clear();
      current?.localStream?.getTracks().forEach((track) => track.stop());
      stateRef.current = null;
    };
  }, []);

  return { state, join, leave, toggleMute, toggleCamera, handleEvent };
}
