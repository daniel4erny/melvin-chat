import { useEffect, useMemo, useState } from "react";
import type { EmojiMartData } from "@emoji-mart/data";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

const RECENT_KEY = "melvin.emoji.recent";

// emoji-mart data is English-only. These aliases make Czech searches work for
// the emoji people actually look for.
const CZECH_ALIASES: Record<string, string> = {
  "😂": "smich smích lol",
  "🤣": "smich smích",
  "😭": "plac pláč brek",
  "😍": "laska láska srdicka srdíčka",
  "❤️": "srdce laska láska",
  "🧡": "srdce oranzove",
  "💔": "zlomene srdce",
  "🔥": "ohen oheň",
  "👍": "palec libi líbí",
  "👎": "palec dolu nelibi",
  "🎉": "party oslava",
  "🥳": "party oslava narozeniny",
  "💀": "lebka smrt",
  "🍺": "pivo",
  "🍻": "pivo pripitek",
  "☕": "kava káva",
  "🚀": "raketa",
  "🐶": "pes pejsek",
  "🐱": "kocka kočka",
  "🌈": "duha",
  "⚡": "blesk",
  "😴": "spanek spánek",
  "🤔": "premysleni přemýšlení",
  "👀": "oci oči",
  "🙏": "diky díky prosim prosím",
  "💯": "sto",
  "✅": "hotovo ano",
  "❌": "ne krizek křížek",
  "🍕": "pizza",
  "🌮": "taco",
  "😎": "pohoda cool",
  "🤯": "sok šok",
  "🫶": "srdicka srdíčka",
  "😀": "smich smích",
  "😢": "plac pláč",
  "🎂": "dort narozeniny",
  "🍀": "stesti štěstí",
  "🌞": "slunce",
  "🌙": "mesic měsíc",
  "⭐": "hvezda hvězda",
};

const CATEGORIES: { id: string; label: string; icon: string }[] = [
  { id: "recent", label: "Často používané", icon: "🕘" },
  { id: "people", label: "Lidé", icon: "😀" },
  { id: "nature", label: "Příroda", icon: "🐻" },
  { id: "foods", label: "Jídlo", icon: "🍔" },
  { id: "activity", label: "Aktivity", icon: "⚽" },
  { id: "places", label: "Místa", icon: "✈️" },
  { id: "objects", label: "Objekty", icon: "💡" },
  { id: "symbols", label: "Symboly", icon: "❤️" },
  { id: "flags", label: "Vlajky", icon: "🏳️" },
];

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]).slice(0, 24) : [];
  } catch {
    return [];
  }
}

function writeRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    // storage can be unavailable in private mode
  }
}

export default function EmojiPicker({
  onPick,
  onClose,
  align = "left",
}: {
  onPick: (emoji: string) => void;
  onClose?: () => void;
  align?: "left" | "right";
}) {
  const [data, setData] = useState<EmojiMartData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("people");
  const [recent, setRecent] = useState<string[]>(readRecent);

  // The full Unicode data set is ~1 MB, so it is loaded only when the picker
  // actually opens. Startup stays instant.
  useEffect(() => {
    let alive = true;
    import("@emoji-mart/data")
      .then((mod) => {
        if (alive) setData(mod.default as EmojiMartData);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const pick = (emoji: string) => {
    onPick(emoji);
    setRecent((prev) => {
      const next = [emoji, ...prev.filter((item) => item !== emoji)].slice(0, 24);
      writeRecent(next);
      return next;
    });
  };

  const results = useMemo(() => {
    if (!data) return [] as { emoji: string; name: string }[];
    const seen = new Set<string>();
    const out: { emoji: string; name: string }[] = [];
    const add = (id: string) => {
      const item = data.emojis[id];
      const native = item?.skins?.[0]?.native;
      if (!native || seen.has(native)) return;
      seen.add(native);
      out.push({ emoji: native, name: item.name });
    };

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      // ids and English names are what the data set offers; keywords catch
      // synonyms like "happy" or "laugh".
      for (const [id, item] of Object.entries(data.emojis)) {
        const czech = CZECH_ALIASES[item.skins?.[0]?.native ?? ""] ?? "";
        const haystack = `${id} ${item.name} ${item.keywords?.join(" ") ?? ""} ${item.emoticons?.join(" ") ?? ""} ${czech}`.toLowerCase();
        if (haystack.includes(q)) add(id);
        if (out.length >= 240) break;
      }
      return out;
    }

    if (category === "recent") {
      for (const emoji of recent) out.push({ emoji, name: "Naposledy použité" });
      return out;
    }
    const cat = data.categories.find((item) => item.id === category);
    for (const id of cat?.emojis ?? []) add(id);
    return out;
  }, [data, query, category, recent]);

  return (
    <div className={`emojiPicker${align === "right" ? " alignRight" : ""}`} onClick={(event) => event.stopPropagation()}>
      <div className="emojiPickerHead">
        <span className="emojiSearchIcon">
          <Icon name="search" size={15} />
        </span>
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose?.();
          }}
          placeholder="Hledat emoji…"
          aria-label="Hledat emoji"
        />
        {onClose && (
          <button className="iconBtn" onClick={onClose} aria-label="Zavřít výběr emoji">
            <Icon name="x" size={15} />
          </button>
        )}
      </div>

      <div className="emojiPickerBody">
        {failed ? (
          <p className="emojiEmpty">Emoji se nepodařilo načíst. Zkus to znovu.</p>
        ) : !data ? (
          <div className="emojiLoading">
            <Spinner size={22} />
            <span>Načítám emoji…</span>
          </div>
        ) : results.length === 0 ? (
          <p className="emojiEmpty">
            {category === "recent" && !query ? "Zatím žádná použitá emoji." : "Nic nenalezeno."}
          </p>
        ) : (
          <div className="emojiGrid">
            {results.map((item, index) => (
              <button
                key={`${item.emoji}-${index}`}
                className="emojiCell"
                title={item.name}
                onClick={() => pick(item.emoji)}
              >
                {item.emoji}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="emojiTabs">
        {CATEGORIES.map((item) => {
          if (item.id === "recent" && recent.length === 0) return null;
          return (
            <button
              key={item.id}
              className={`emojiTab${category === item.id && !query ? " active" : ""}`}
              title={item.label}
              onClick={() => {
                setQuery("");
                setCategory(item.id);
              }}
            >
              {item.icon}
            </button>
          );
        })}
      </div>
    </div>
  );
}
