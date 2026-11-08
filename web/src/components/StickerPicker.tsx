import { useEffect, useRef, useState } from "react";
import { api, fileURL, uploadBlob } from "../api";
import { toast } from "../toast";
import type { Sticker } from "../types";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

const STICKER_SIZE = 512;

// Stickers are square PNGs with a transparent background so they sit nicely
// on both dark and light chat themes.
export async function imageToSticker(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/")) {
    throw new Error("Stiker musí být obrázek");
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, STICKER_SIZE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = STICKER_SIZE;
  canvas.height = STICKER_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Prohlížeč neumí zpracovat obrázek");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (STICKER_SIZE - width) / 2, (STICKER_SIZE - height) / 2, width, height);
  if ("close" in bitmap) bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png", 0.92),
  );
  if (!blob) throw new Error("Obrázek se nepodařilo zpracovat");
  return blob;
}

export default function StickerPicker({
  onPick,
  onClose,
}: {
  onPick: (sticker: Sticker) => void;
  onClose?: () => void;
}) {
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api<{ stickers: Sticker[] }>("/api/stickers")
      .then((res) => {
        if (alive) setStickers(res.stickers ?? []);
      })
      .catch(() => {
        if (alive) toast.error("Stikery se nepodařilo načíst");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const upload = async (file: File) => {
    setUploading(true);
    setProgress(0);
    try {
      const blob = await imageToSticker(file);
      const name = file.name.replace(/\.[^.]+$/, "").slice(0, 40) || "Stiker";
      const attachment = await uploadBlob(blob, `${name}.png`, "sticker", 0, (uploaded, total) =>
        setProgress(total > 0 ? Math.round((uploaded / total) * 100) : 0),
      );
      const res = await api<{ sticker: Sticker }>("/api/stickers", {
        method: "POST",
        body: { attachmentId: attachment.id, name },
      });
      setStickers((prev) => [res.sticker, ...prev]);
      toast.success("Stiker přidán");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stiker se nepodařilo přidat");
    } finally {
      setUploading(false);
      setProgress(0);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const remove = async (sticker: Sticker) => {
    if (!window.confirm(`Smazat stiker „${sticker.name || sticker.emoji}“?`)) return;
    try {
      await api(`/api/stickers/${sticker.id}`, { method: "DELETE" });
      setStickers((prev) => prev.filter((item) => item.id !== sticker.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stiker se nepodařilo smazat");
    }
  };

  const custom = stickers.filter((sticker) => sticker.userId !== 0);
  const builtin = stickers.filter((sticker) => sticker.userId === 0);

  const renderGrid = (items: Sticker[], deletable: boolean) => (
    <div className="stickerGrid">
      {items.map((sticker) => (
        <div className="stickerCellWrap" key={sticker.id}>
          <button
            className="stickerCell"
            title={sticker.name || "Stiker"}
            onClick={() => onPick(sticker)}
          >
            {sticker.emoji ? (
              <span className="stickerEmojiCell">{sticker.emoji}</span>
            ) : sticker.attachmentId ? (
              <img src={fileURL(sticker.attachmentId)} alt={sticker.name} loading="lazy" />
            ) : null}
          </button>
          {deletable && (
            <button
              className="stickerRemove"
              title="Smazat stiker"
              aria-label="Smazat stiker"
              onClick={() => void remove(sticker)}
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="stickerPicker" onClick={(event) => event.stopPropagation()}>
      <div className="stickerPickerHead">
        <strong>
          <Icon name="sticker" size={16} /> Stikery
        </strong>
        <div className="row gap">
          <button
            className="btn tiny"
            onClick={() => fileInput.current?.click()}
            disabled={uploading}
          >
            {uploading ? <Spinner size={13} /> : <Icon name="plus" size={13} />} Nahrát
          </button>
          {onClose && (
            <button className="iconBtn" onClick={onClose} aria-label="Zavřít stikery">
              <Icon name="x" size={15} />
            </button>
          )}
        </div>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />

      {uploading && (
        <div className="stickerUpload">
          <span className="uploadTrack">
            <span className="uploadFill" style={{ width: `${progress}%` }} />
          </span>
          <span>{progress} %</span>
        </div>
      )}

      <div className="stickerScroll">
        {loading ? (
          <div className="emojiLoading">
            <Spinner size={20} />
            <span>Načítám stikery…</span>
          </div>
        ) : (
          <>
            <div className="stickerSectionTitle">
              <span>Moje stikery</span>
              <small>{custom.length}</small>
            </div>
            {custom.length > 0 ? (
              renderGrid(custom, true)
            ) : (
              <p className="stickerHint">
                Nahraj si vlastní obrázek – ideálně čtvercový PNG s průhledným pozadím.
              </p>
            )}
            <div className="stickerSectionTitle">
              <span>Základní balíček</span>
            </div>
            {renderGrid(builtin, false)}
          </>
        )}
      </div>
    </div>
  );
}
