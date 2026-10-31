import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { Modal, Spinner } from "./ui";

export default function PollModal({
  open,
  channelName,
  dm,
  onClose,
  onCreate,
}: {
  open: boolean;
  channelName: string;
  dm?: boolean;
  onClose: () => void;
  onCreate: (question: string, options: string[], multi: boolean, anonymous: boolean) => Promise<void>;
}) {
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuestion("");
    setOptions(["", ""]);
    setMulti(false);
    setAnonymous(false);
    setError("");
    setSaving(false);
  }, [open]);

  const updateOption = (index: number, value: string) => {
    setOptions((prev) => prev.map((o, i) => (i === index ? value : o)));
  };

  const submit = async () => {
    setError("");
    const clean = options.map((o) => o.trim()).filter(Boolean);
    if (question.trim().length < 3) {
      setError("Napiš otázku (alespoň 3 znaky)");
      return;
    }
    if (clean.length < 2) {
      setError("Potřebuješ alespoň 2 odpovědi");
      return;
    }
    setSaving(true);
    try {
      await onCreate(question.trim(), clean, multi, anonymous);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Anketu se nepodařilo vytvořit");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nová anketa"
      subtitle={dm ? `Konverzace s ${channelName}` : `V kanálu #${channelName}`}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Zrušit
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={saving}>
            {saving ? <Spinner size={16} /> : <Icon name="poll" size={16} />} Vytvořit anketu
          </button>
        </>
      }
    >
      <label className="field">
        <span>Otázka</span>
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Půjdeme v pátek na pivo?"
          maxLength={200}
          autoFocus
        />
      </label>

      <div className="field">
        <span>Odpovědi</span>
        <div className="pollOptionInputs">
          {options.map((option, index) => (
            <div className="pollOptionInput" key={index}>
              <span className="pollOptionIndex">{index + 1}</span>
              <input
                value={option}
                onChange={(e) => updateOption(index, e.target.value)}
                placeholder={`Možnost ${index + 1}`}
                maxLength={80}
              />
              {options.length > 2 && (
                <button
                  className="iconBtn"
                  onClick={() => setOptions((prev) => prev.filter((_, i) => i !== index))}
                  aria-label="Odebrat možnost"
                >
                  <Icon name="x" size={15} />
                </button>
              )}
            </div>
          ))}
        </div>
        {options.length < 10 && (
          <button className="btn tiny ghost addOption" onClick={() => setOptions((prev) => [...prev, ""])}>
            <Icon name="plus" size={14} /> Přidat možnost
          </button>
        )}
      </div>

      <div className="toggleRows">
        <label className="toggleRow">
          <span>
            <strong>Více odpovědí</strong>
            <small>Každý může vybrat víc než jednu možnost</small>
          </span>
          <input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} />
        </label>
        <label className="toggleRow">
          <span>
            <strong>Anonymní</strong>
            <small>Nezobrazovat, kdo jak hlasoval</small>
          </span>
          <input type="checkbox" checked={anonymous} onChange={(e) => setAnonymous(e.target.checked)} />
        </label>
      </div>

      {error && <div className="formError">{error}</div>}
    </Modal>
  );
}
