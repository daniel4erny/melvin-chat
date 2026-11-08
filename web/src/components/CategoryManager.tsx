import { useEffect, useState } from "react";
import { api } from "../api";
import { PERM_MANAGE_CHANNELS, type ChannelCategory, type User } from "../types";
import { toast } from "../toast";
import { Icon } from "./Icon";
import { Modal, Spinner } from "./ui";

export default function CategoryManager({
  open,
  categories,
  me,
  onClose,
  onChanged,
}: {
  open: boolean;
  categories: ChannelCategory[];
  me: User;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setName("");
    setEditingId(null);
    setEditName("");
    setError("");
  }, [open]);

  const canManage = (category: ChannelCategory) =>
    me.admin ||
    category.createdBy === me.id ||
    ((me.permissions ?? 0) & PERM_MANAGE_CHANNELS) !== 0;
  const canManageAll = categories.every(canManage);

  const create = async () => {
    const clean = name.trim();
    if (!clean) {
      setError("Zadej název kategorie");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api("/api/categories", { method: "POST", body: { name: clean } });
      setName("");
      onChanged();
      toast.success(`Kategorie ${clean} vytvořena`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kategorii se nepodařilo vytvořit");
    } finally {
      setBusy(false);
    }
  };

  const rename = async (category: ChannelCategory) => {
    const clean = editName.trim();
    if (!clean) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/categories/${category.id}`, { method: "PATCH", body: { name: clean } });
      setEditingId(null);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kategorii se nepodařilo upravit");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (category: ChannelCategory) => {
    if (!window.confirm(`Smazat kategorii ${category.name}? Kanály zůstanou, jen se přesunou mimo kategorie.`)) {
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api(`/api/categories/${category.id}`, { method: "DELETE" });
      onChanged();
      toast.success("Kategorie smazána");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kategorii se nepodařilo smazat");
    } finally {
      setBusy(false);
    }
  };

  const move = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= categories.length) return;
    const ids = categories.map((category) => category.id);
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setBusy(true);
    setError("");
    try {
      await api("/api/categories/reorder", { method: "POST", body: { ids } });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Kategorie se nepodařilo přeskládat");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Kategorie"
      subtitle="Rozděl kanály do složek jako na Discordu. Kategorie vidí všichni."
      footer={
        <>
          <span className="spacer" />
          <button className="btn ghost" onClick={onClose}>
            Zavřít
          </button>
        </>
      }
    >
      <div className="categoryManager">
        {categories.length === 0 && (
          <p className="hintBox">
            <Icon name="info" size={15} /> Zatím žádné kategorie. Vytvoř první a přesuň do ní kanály.
          </p>
        )}
        <div className="categoryManagerList">
          {categories.map((category, index) => (
            <div className="categoryManagerRow" key={category.id}>
              <span className="categoryManagerIcon">
                <Icon name="folder" size={17} />
              </span>
              {editingId === category.id ? (
                <input
                  className="categoryManagerInput"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={40}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void rename(category);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                />
              ) : (
                <strong>{category.name}</strong>
              )}
              <div className="categoryManagerActions">
                {editingId === category.id ? (
                  <>
                    <button
                      className="iconBtn"
                      title="Uložit"
                      aria-label="Uložit"
                      disabled={busy}
                      onClick={() => void rename(category)}
                    >
                      <Icon name="check" size={16} />
                    </button>
                    <button
                      className="iconBtn"
                      title="Zrušit"
                      aria-label="Zrušit"
                      onClick={() => setEditingId(null)}
                    >
                      <Icon name="x" size={16} />
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="iconBtn"
                      title="Nahoru"
                      aria-label="Nahoru"
                      disabled={busy || !canManageAll || index === 0}
                      onClick={() => void move(index, -1)}
                    >
                      <Icon name="chevron" size={16} className="flipUp" />
                    </button>
                    <button
                      className="iconBtn"
                      title="Dolů"
                      aria-label="Dolů"
                      disabled={busy || !canManageAll || index === categories.length - 1}
                      onClick={() => void move(index, 1)}
                    >
                      <Icon name="chevron" size={16} />
                    </button>
                    {canManage(category) && (
                      <>
                        <button
                          className="iconBtn"
                          title="Přejmenovat"
                          aria-label="Přejmenovat"
                          onClick={() => {
                            setEditingId(category.id);
                            setEditName(category.name);
                          }}
                        >
                          <Icon name="pencil" size={16} />
                        </button>
                        <button
                          className="iconBtn danger"
                          title="Smazat"
                          aria-label="Smazat"
                          onClick={() => void remove(category)}
                          disabled={busy}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="categoryAddRow">
          <div className="inputWrap">
            <Icon name="folder" size={16} />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nová kategorie, třeba Komunita"
              maxLength={40}
              onKeyDown={(e) => {
                if (e.key === "Enter") void create();
              }}
            />
          </div>
          <button className="btn primary" onClick={() => void create()} disabled={busy}>
            {busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Přidat
          </button>
        </div>

        {error && <div className="formError">{error}</div>}
      </div>
    </Modal>
  );
}
