import { useEffect, useRef, useState } from "react";
import { kindFromFile, uploadBlob } from "../api";
import { socket } from "../ws";
import { toast } from "../toast";
import type { Attachment, Message } from "../types";
import { formatDuration, formatSize } from "../utils";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

const EMOJIS = ["😀", "😂", "🥹", "😍", "😎", "🤔", "😭", "🔥", "❤️", "👍", "👎", "🎉", "💀", "🍺", "☕", "🚀"];

export default function Composer({
  channelId,
  channelName,
  replyTo,
  maxUploadMB,
  enterToSend,
  onCancelReply,
  onSend,
  onPoll,
}: {
  channelId: number;
  channelName: string;
  replyTo: Message | null;
  maxUploadMB: number;
  enterToSend: boolean;
  onCancelReply: () => void;
  onSend: (text: string, attachmentId?: string, replyTo?: number) => Promise<void>;
  onPoll: () => void;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const fileInput = useRef<HTMLInputElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<number | null>(null);
  const secondsRef = useRef(0);
  const discard = useRef(false);
  const typingAt = useRef(0);

  useEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearInterval(timer.current);
      if (recorder.current && recorder.current.state !== "inactive") {
        discard.current = true;
        recorder.current.stop();
      }
      stream.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    setPending([]);
    setEmojiOpen(false);
    setText("");
    if (recorder.current && recorder.current.state !== "inactive") {
      discard.current = true;
      recorder.current.stop();
    }
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
      onCancelReply();
      setEmojiOpen(false);
    } catch {
      // Chat already reports the error
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && enterToSend) {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") onCancelReply();
  };

  const onTextChange = (value: string) => {
    setText(value);
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

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    if (recording) return;
    const files = Array.from(list).slice(0, 5);
    for (const file of files) {
      await upload(file);
    }
    if (fileInput.current) fileInput.current.value = "";
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

      rec.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      rec.onstop = () => {
        const duration = secondsRef.current;
        audio.getTracks().forEach((t) => t.stop());
        stream.current = null;
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
    <div className="composerWrap">
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

      {recording ? (
        <div className="composer recordingBar">
          <span className="recordDot" />
          <span className="recordTimer">Nahrávám {formatDuration(seconds)}</span>
          <span className="recordHint">Klikni na fajfku pro odeslání</span>
          <button className="iconBtn" onClick={() => stopRecording(true)} title="Zahodit">
            <Icon name="trash" size={18} />
          </button>
          <button className="iconBtn send" onClick={() => stopRecording(false)} title="Odeslat hlasovku">
            <Icon name="check" size={19} />
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
            placeholder={`Napiš zprávu do #${channelName}…`}
            onChange={(e) => onTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
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
