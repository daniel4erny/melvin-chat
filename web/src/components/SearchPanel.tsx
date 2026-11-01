import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { Message } from "../types";
import { formatDateTime } from "../utils";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

export default function SearchPanel({
  channelId,
  channelName,
  dm,
  onJump,
  onClose,
}: {
  channelId: number;
  channelName: string;
  dm?: boolean;
  onJump: (messageId: number) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Message[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setResults(null);
      setError("");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    const timer = window.setTimeout(() => {
      api<{ messages: Message[] }>(`/api/channels/${channelId}/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => setResults(res.messages))
        .catch((err) => {
          setResults([]);
          setError(err instanceof Error ? err.message : "Hledání selhalo");
        })
        .finally(() => setLoading(false));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, channelId]);

  return (
    <div className="searchPanel" role="dialog" aria-label="Hledat ve zprávách">
      <div className="searchPanelHead">
        <Icon name="search" size={18} />
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={dm ? `Hledat u ${channelName}` : `Hledat v #${channelName}`}
          maxLength={120}
          spellCheck={false}
        />
        {loading && <Spinner size={16} />}
        <button className="iconBtn" onClick={onClose} aria-label="Zavřít hledání">
          <Icon name="x" size={18} />
        </button>
      </div>

      <div className="searchResults">
        {query.trim().length < 2 && (
          <p className="searchHint">
            Napiš alespoň dva znaky. Hledá se v textu zpráv, ve jménech autorů i v názvech souborů.
          </p>
        )}
        {error && <p className="searchHint error">{error}</p>}
        {results && results.length === 0 && !loading && !error && (
          <p className="searchHint">Nic nenalezeno.</p>
        )}
        {results?.map((message) => (
          <button key={message.id} className="searchResult" onClick={() => onJump(message.id)}>
            <span className="searchResultAuthor">
              {message.user.displayName}
              <time>{formatDateTime(message.createdAt)}</time>
            </span>
            <span className="searchResultText">
              {message.text || message.attachment?.name || message.poll?.question || "zpráva"}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
