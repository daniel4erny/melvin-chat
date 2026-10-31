import { useEffect, useMemo, useRef, useState } from "react";
import { kindFromFile, uploadBlob } from "../api";
import { socket } from "../ws";
import { toast } from "../toast";
import type { Attachment, Message, User } from "../types";
import { formatDuration, formatSize, timeoutLabel } from "../utils";
import { Icon } from "./Icon";
import { Avatar, Spinner } from "./ui";

const EMOJIS = ["😀", "😂", "🥹", "😍", "😎", "🤔", "😭", "🔥", "❤️", "👍", "👎", "🎉", "💀", "🍺", "☕", "🚀"];

function filesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  if (data.items && data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0 && data.files) {
    for (const file of Array.from(data.files)) files.push(file);
  }
  return files;
}

function namePastedFile(file: File): File {
  if (file.name && file.name !== "image.png" && file.name !== "blob") return file;
  const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
  return new File([file], `screenshot-${Date.now()}.${ext}`, { type: file.type });
}

export default function Composer({
  channelId,
  channelName,
  dm = false,
  replyTo,
  maxUploadMB,
  enterToSend,
  members,
  onCancelReply,
  onSend,
  onPoll,
  timeoutMsLeft = 0,
  timeoutReason = "",
}: {
  channelId: number;
  channelName: string;
  dm?: boolean;
  replyTo: Message | null;
  maxUploadMB: number;
  enterToSend: boolean;
  members: User[];
  onCancelReply: () => void;
  onSend: (text: string, attachmentId?: string, replyTo?: number) => Promise<void>;
  onPoll: () => void;
  timeoutMsLeft?: number;
  timeoutReason?: string;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => Array(30).fill(0.06));
  const [dragging, setDragging] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const secondsRef = useRef(0);
  const discard = useRef(false);
  const typingAt = useRef(0);
  const channelRef = useRef(channelId);
  const meter = useRef<{
    ctx: AudioContext;
    source: MediaStreamAudioSourceNode;
    analyser: AnalyserNode;
    data: Uint8Array;
    timer: number;
  } | null>(null);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const stopMeter = () => {
    if (!meter.current) return;
    window.clearInterval(meter.current.timer);
    try {
      meter.current.source.disconnect();
      void meter.current.ctx.close();
    } catch {
      // already closed
    }
    meter.current = null;
    setLevel(0);
    setLevels(Array(30).fill(0.06));
  };

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
      if (recorder.current && recorder.current.state !== "inactive") {
        discard.current = true;
        recorder.current.stop();
        socket.send({ type: "voice:recording", channelId: channelRef.current, recording: false });
      }
      stopMeter();
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    setPending([]);
    setEmojiOpen(false);
    setText("");
    setMention(null);
    if (recorder.current && recorder.current.state !== "inactive") {
      discard.current = true;
      recorder.current.stop();
      socket.send({ type: "voice:recording", channelId: channelRef.current, recording: false });
    }
    channelRef.current = channelId;
  }, [channelId]);

  const send = async () => {
    if (sending) return;
    const value = text.trim();
    if (!value && pending.length === 0) return;
    setSending(true);
    try {
      if (pending.length === 0) {
        await onSend(value, undefined, replyTo?.id);
      } else {
        let first = true;
        for (const attachment of pending) {
          await onSend(first ? value : "", attachment.id, first ? replyTo?.id : undefined);
          first = false;
        }
      }
      setText("");
      setPending([]);
      setMention(null);
      onCancelReply();
      setEmojiOpen(false);
    } catch {
      // Chat already reports the error
    } finally {
      setSending(false);
    }
  };

  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((member) => member.id !== 0)
      .filter(
        (member) =>
          member.username.toLowerCase().startsWith(q) ||
          member.displayName.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [mention, members]);

  const applyMention = (username: string) => {
    const el = textarea.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? text.length;
    const next = `${text.slice(0, mention.start)}@${username} ${text.slice(caret)}`;
    setMention(null);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const pos = mention.start + username.length + 2;
      el.setSelectionRange(pos, pos);
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mention && mentionMatches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((index) => (index - 1 + mentionMatches.length) % mentionMatches.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyMention(mentionMatches[mentionIndex]!.username);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && enterToSend) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") onCancelReply();
  };

  const onTextChange = (value: string, caret?: number | null) => {
    setText(value);
    const position = caret ?? value.length;
    const before = value.slice(0, position);
    const match = /(?:^|[\s(])@([a-zA-Z0-9_.-]*)$/.exec(before);
    if (match) {
      const query = match[1] ?? "";
      setMention({ start: position - query.length - 1, query });
      setMentionIndex(0);
    } else {
      setMention(null);
    }
    const now = Date.now();
    if (now - typingAt.current > 2500) {
      typingAt.current = now;
      socket.send({ type: "typing", channelId });
    }
  };

  const upload = async (file: File) => {
    const maxBytes = maxUploadMB * 1024 * 1024;
    if (file.size > maxBytes) {
      toast.error(`Soubor je větší než ${maxUploadMB} MB`);
      return;
    }
    setUploading({ name: file.name, percent: 0 });
    try {
      const attachment = await uploadBlob(
        file,
        file.name,
        kindFromFile(file),
        0,
        (uploaded, total) => setUploading({ name: file.name, percent: Math.round((uploaded / total) * 100) }),
      );
      setPending((prev) => [...prev, attachment]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Nahrávání selhalo");
    } finally {
      setUploading(null);
    }
  };

  const handleFiles = async (list: FileList | File[] | null) => {
    if (!list) return;
    const files = Array.from(list).slice(0, 5);
    if (files.length === 0) return;
    if (recording) return;
    for (const file of files) {
      await upload(file);
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;

  // Ctrl+V / Cmd+V anywhere in the chat: paste screenshots and copied files.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Ignore pastes into unrelated form fields (settings, login, rename inputs).
      if (
        target &&
        target !== document.body &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA") &&
        target !== textarea.current
      ) {
        return;
      }
      const files = filesFrom(event.clipboardData).map(namePastedFile);
      if (files.length === 0) return;
      event.preventDefault();
      void handleFilesRef.current(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, []);

  const startMeter = (audio: MediaStream) => {
    try {
      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(audio);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const meterTimer = window.setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const value of data) peak = Math.max(peak, Math.abs(value - 128) / 128);
        setLevel(peak);
        setLevels((prev) => [...prev.slice(1), Math.max(0.06, Math.min(1, peak * 2.4))]);
      }, 90);
      meter.current = { ctx, source, analyser, data, timer: meterTimer };
    } catch {
      // level meter is a nice-to-have
    }
  };

  const startRecording = async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast.error("Tvůj prohlížeč neumí nahrávat zvuk");
      return;
    }
    try {
      const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.current = audio;
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
      const mime = preferred.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
      const rec = new MediaRecorder(audio, mime ? { mimeType: mime } : undefined);
      recorder.current = rec;
      chunks.current = [];
      discard.current = false;
      secondsRef.current = 0;
      setSeconds(0);
      setLevels(Array(30).fill(0.06));
      startMeter(audio);
      socket.send({ type: "voice:recording", channelId, recording: true });

      rec.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      rec.onstop = () => {
        const duration = secondsRef.current;
        audio.getTracks().forEach((t) => t.stop());
        stream.current = null;
        stopMeter();
        socket.send({ type: "voice:recording", channelId, recording: false });
        setRecording(false);
        if (timer.current !== null) {
          clearInterval(timer.current);
          timer.current = null;
        }
        if (discard.current) return;
        const type = rec.mimeType || "audio/webm";
        const blob = new Blob(chunks.current, { type });
        const ext = type.includes("mp4") ? "m4a" : "webm";
        const file = new File([blob], `hlasovka-${Date.now()}.${ext}`, { type });
        if (blob.size < 1000) {
          toast.error("Nahrávka je moc krátká");
          return;
        }
        setUploading({ name: "Hlasovka", percent: 0 });
        void uploadBlob(file, file.name, "voice", duration, (uploaded, total) =>
          setUploading({ name: "Hlasovka", percent: Math.round((uploaded / total) * 100) }),
        )
          .then((attachment) => onSend("", attachment.id))
          .catch((err) => toast.error(err instanceof Error ? err.message : "Hlasovku se nepodařilo odeslat"))
          .finally(() => setUploading(null));
      };
      rec.start(200);
      setRecording(true);
      timer.current = window.setInterval(() => {
        secondsRef.current += 1;
        setSeconds(secondsRef.current);
        if (secondsRef.current >= 300) stopRecording(false);
      }, 1000);
    } catch {
      stopMeter();
      toast.error("Nepodařilo se spustit nahrávání. Povol mikrofon.");
    }
  };

  const stopRecording = (cancel: boolean) => {
    discard.current = cancel;
    if (recorder.current && recorder.current.state !== "inactive") recorder.current.stop();
    setRecording(false);
  };

  const insertEmoji = (emoji: string) => {
    onTextChange(text + emoji);
    textarea.current?.focus();
  };

  return (
    <div
      className="composerWrap"
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes("Files")) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        void handleFiles(filesFrom(event.dataTransfer).map(namePastedFile));
      }}
    >
      {dragging && (
        <div className="dropOverlay">
          <Icon name="paperclip" size={22} />
          <span>Pustit soubor do chatu</span>
        </div>
      )}

      {replyTo && (
        <div className="replyBar">
          <Icon name="reply" size={14} />
          <span>
            Odpovídáš na <strong>{replyTo.user.displayName}</strong>
            {replyTo.text ? `: ${replyTo.text.slice(0, 80)}` : ""}
          </span>
          <button className="iconBtn" onClick={onCancelReply} aria-label="Zrušit odpověď">
            <Icon name="x" size={15} />
          </button>
        </div>
      )}

      {pending.length > 0 && (
        <div className="pendingAttachments">
          {pending.map((att) => (
            <span className="attachmentChip" key={att.id}>
              <Icon name={att.kind === "image" ? "image" : att.kind === "video" ? "video" : "file"} size={14} />
              <span className="attachmentChipName">{att.name}</span>
              <small>{formatSize(att.size)}</small>
              <button
                className="iconBtn"
                onClick={() => setPending((prev) => prev.filter((p) => p.id !== att.id))}
                aria-label="Odebrat přílohu"
              >
                <Icon name="x" size={13} />
              </button>
            </span>
          ))}
        </div>
      )}

      {uploading && (
        <div className="uploadBar">
          <span className="uploadName">
            <Icon name="paperclip" size={14} /> {uploading.name}
          </span>
          <span className="uploadTrack">
            <span className="uploadFill" style={{ width: `${uploading.percent}%` }} />
          </span>
          <span className="uploadPercent">{uploading.percent} %</span>
        </div>
      )}

      {emojiOpen && (
        <div className="emojiPop composerEmojiPop">
          {EMOJIS.map((emoji) => (
            <button key={emoji} onClick={() => insertEmoji(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}

      {mention && mentionMatches.length > 0 && (
        <div className="mentionPop">
          <span className="mentionPopHint">Zmínit uživatele</span>
          {mentionMatches.map((member, index) => (
            <button
              key={member.id}
              className={index === mentionIndex ? "active" : ""}
              onMouseDown={(event) => {
                event.preventDefault();
                applyMention(member.username);
              }}
            >
              <Avatar name={member.displayName} color={member.avatarColor} avatarId={member.avatarId} size={22} />
              <span className="mentionName">{member.displayName}</span>
              <span className="mentionHandle">@{member.username}</span>
            </button>
          ))}
        </div>
      )}

      {timeoutMsLeft > 0 ? (
        <div className="composerTimeout">
          <span className="composerTimeoutIcon">
            <Icon name="clock" size={19} />
          </span>
          <div className="composerTimeoutText">
            <strong>Máš timeout</strong>
            <span>
              Psát, reagovat a volat můžeš znovu za <b>{timeoutLabel(timeoutMsLeft)}</b>
              {timeoutReason ? ` · ${timeoutReason}` : ""}
            </span>
          </div>
        </div>
      ) : recording ? (
        <div className="composer recordingBar" style={{ boxShadow: `0 0 0 ${Math.round(2 + level * 8)}px rgba(237, 66, 69, 0.12)` }}>
          <span className="recordDot" />
          <span className="recordTimer">{formatDuration(seconds)}</span>
          <div className="recordWave" aria-hidden="true">
            {levels.map((value, index) => (
              <span
                key={index}
                className="recordWaveBar"
                style={{ height: `${Math.max(8, Math.round(value * 100))}%` }}
              />
            ))}
          </div>
          <span className="recordHint">Nahrávám hlasovku…</span>
          <button className="iconBtn recordCancel" onClick={() => stopRecording(true)} title="Zahodit nahrávku" aria-label="Zahodit nahrávku">
            <Icon name="trash" size={18} />
          </button>
          <button className="sendBtn recordSend" onClick={() => stopRecording(false)} title="Odeslat hlasovku" aria-label="Odeslat hlasovku">
            <Icon name="check" size={20} />
          </button>
        </div>
      ) : (
        <div className="composer">
          <input
            ref={fileInput}
            type="file"
            hidden
            multiple
            onChange={(e) => void handleFiles(e.target.files)}
          />
          <button className="iconBtn" title="Přiložit soubor" onClick={() => fileInput.current?.click()}>
            <Icon name="paperclip" size={19} />
          </button>
          <button className="iconBtn" title="Vytvořit anketu" onClick={onPoll}>
            <Icon name="poll" size={19} />
          </button>
          <button
            className={`iconBtn${emojiOpen ? " active" : ""}`}
            title="Emoji"
            onClick={() => setEmojiOpen((v) => !v)}
          >
            <Icon name="smile" size={19} />
          </button>

          <textarea
            ref={textarea}
            rows={1}
            value={text}
            placeholder={dm ? `Napiš zprávu pro ${channelName}` : `Napiš zprávu do #${channelName}`}
            onChange={(e) => onTextChange(e.target.value, e.target.selectionStart)}
            onKeyDown={handleKeyDown}
            onBlur={() => setMention(null)}
            maxLength={8000}
          />

          {uploading ? (
            <span className="sendSpinner">
              <Spinner size={20} />
            </span>
          ) : text.trim() || pending.length > 0 ? (
            <button className="sendBtn" onClick={() => void send()} disabled={sending} title="Odeslat">
              {sending ? <Spinner size={18} /> : <Icon name="send" size={19} />}
            </button>
          ) : (
            <button className="sendBtn mic" onClick={() => void startRecording()} title="Nahrát hlasovku">
              <Icon name="mic" size={19} />
            </button>
          )}
        </div>
      )}
      {text.length > 7500 && <div className="charCount">{text.length}/8000</div>}
    </div>
  );
}
