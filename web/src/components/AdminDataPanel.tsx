import { useEffect, useMemo, useRef, useState } from "react";
import { api, fileURL } from "../api";
import { toast } from "../toast";
import { formatDateTime, formatSize } from "../utils";
import { Icon } from "./Icon";
import { Spinner } from "./ui";

type Overview = {
  counts: Record<string, number>;
  dbBytes: number;
  fileBytes: number;
  tables: string[];
};

type AdminFile = {
  id: string;
  name: string;
  mime: string;
  kind: string;
  size: number;
  createdAt: number;
  uploaderId: number;
  uploader: string;
  username: string;
  channelId: number;
  channel: string;
};

type TableMeta = { name: string; rows: number; hidden: Record<string, boolean> };

const PAGE = 25;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="dataStat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export default function AdminDataPanel() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [files, setFiles] = useState<AdminFile[] | null>(null);
  const [fileTotal, setFileTotal] = useState(0);
  const [fileQuery, setFileQuery] = useState("");
  const [fileOffset, setFileOffset] = useState(0);
  const [filesLoading, setFilesLoading] = useState(false);

  const [tables, setTables] = useState<TableMeta[]>([]);
  const [table, setTable] = useState("");
  const [tableQuery, setTableQuery] = useState("");
  const [tableOffset, setTableOffset] = useState(0);
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [tableTotal, setTableTotal] = useState(0);
  const [tableLoading, setTableLoading] = useState(false);
  const [tablesLoading, setTablesLoading] = useState(true);

  const fileTimer = useRef<number | undefined>(undefined);
  const tableTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    api<Overview>("/api/admin/overview")
      .then(setOverview)
      .catch((err) => toast.error(err instanceof Error ? err.message : "Přehled se nepodařilo načíst"));
    api<{ tables: TableMeta[] }>("/api/admin/tables")
      .then((res) => {
        setTables(res.tables);
        if (res.tables.length > 0) setTable((prev) => prev || res.tables[0]!.name);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Tabulky se nepodařilo načíst"))
      .finally(() => setTablesLoading(false));
  }, []);

  useEffect(() => {
    setFilesLoading(true);
    const timer = window.setTimeout(
      () => {
        api<{ files: AdminFile[]; total: number }>(
          `/api/admin/files?q=${encodeURIComponent(fileQuery.trim())}&limit=${PAGE}&offset=${fileOffset}`,
        )
          .then((res) => {
            setFiles(res.files);
            setFileTotal(res.total);
          })
          .catch((err) => {
            setFiles([]);
            toast.error(err instanceof Error ? err.message : "Soubory se nepodařilo načíst");
          })
          .finally(() => setFilesLoading(false));
      },
      fileOffset === 0 ? 0 : 120,
    );
    return () => window.clearTimeout(timer);
  }, [fileQuery, fileOffset]);

  useEffect(() => {
    if (!table) return;
    setTableLoading(true);
    const timer = window.setTimeout(
      () => {
        api<{ columns: string[]; rows: unknown[][]; total: number }>(
          `/api/admin/table/${table}?q=${encodeURIComponent(tableQuery.trim())}&limit=50&offset=${tableOffset}`,
        )
          .then((res) => {
            setColumns(res.columns);
            setRows(res.rows);
            setTableTotal(res.total);
          })
          .catch((err) => {
            setColumns([]);
            setRows([]);
            toast.error(err instanceof Error ? err.message : "Tabulku se nepodařilo načíst");
          })
          .finally(() => setTableLoading(false));
      },
      tableOffset === 0 ? 0 : 120,
    );
    return () => window.clearTimeout(timer);
  }, [table, tableQuery, tableOffset]);

  useEffect(() => {
    if (fileTimer.current) window.clearTimeout(fileTimer.current);
    setFileOffset(0);
  }, [fileQuery]);

  useEffect(() => {
    if (tableTimer.current) window.clearTimeout(tableTimer.current);
    setTableOffset(0);
  }, [tableQuery, table]);

  const counts = overview?.counts ?? {};
  const filesEnd = Math.min(fileOffset + PAGE, fileTotal);
  const tableEnd = Math.min(tableOffset + 50, tableTotal);

  const tableOptions = useMemo(() => tables.slice().sort((a, b) => a.name.localeCompare(b.name)), [tables]);

  return (
    <div className="adminData">
      {overview && (
        <div className="dataStats">
          <Stat label="uživatelů" value={String(counts.users ?? 0)} />
          <Stat label="kanálů" value={String(counts.channels ?? 0)} />
          <Stat label="zpráv" value={String(counts.messages ?? 0)} />
          <Stat label="souborů" value={String(counts.attachments ?? 0)} />
          <Stat label="data souborů" value={formatSize(overview.fileBytes)} />
          <Stat label="databáze" value={formatSize(overview.dbBytes)} />
        </div>
      )}

      <section className="dataBlock">
        <header className="dataBlockHead">
          <h4>
            <Icon name="file" size={15} /> Všechny soubory
          </h4>
          <div className="dataSearch">
            <Icon name="search" size={15} />
            <input
              value={fileQuery}
              onChange={(e) => setFileQuery(e.target.value)}
              placeholder="Název, autor nebo kanál…"
            />
            {filesLoading && <Spinner size={14} />}
          </div>
        </header>

        {files && files.length === 0 && !filesLoading && <p className="dataEmpty">Nic nenalezeno.</p>}
        {files && files.length > 0 && (
          <div className="dataFileList">
            {files.map((file) => (
              <div className="dataFileRow" key={file.id}>
                <span className={`dataFileIcon kind-${file.kind}`}>
                  <Icon name={file.kind === "image" ? "image" : file.kind === "video" ? "video" : file.kind === "audio" || file.kind === "voice" ? "volume" : "file"} size={15} />
                </span>
                <span className="dataFileMain">
                  <strong title={file.name}>{file.name}</strong>
                  <span>
                    {file.uploader} · {file.channel ? `#${file.channel}` : "bez kanálu"} ·{" "}
                    {formatSize(file.size)} · {formatDateTime(file.createdAt)}
                  </span>
                </span>
                <a className="iconBtn" href={fileURL(file.id)} download={file.name} title="Stáhnout">
                  <Icon name="download" size={15} />
                </a>
              </div>
            ))}
          </div>
        )}

        {fileTotal > PAGE && (
          <div className="dataPager">
            <span>
              {fileOffset + 1}–{filesEnd} z {fileTotal}
            </span>
            <button
              className="btn ghost tiny"
              disabled={fileOffset === 0 || filesLoading}
              onClick={() => setFileOffset((n) => Math.max(0, n - PAGE))}
            >
              Zpět
            </button>
            <button
              className="btn ghost tiny"
              disabled={filesEnd >= fileTotal || filesLoading}
              onClick={() => setFileOffset((n) => n + PAGE)}
            >
              Další
            </button>
          </div>
        )}
      </section>

      <section className="dataBlock">
        <header className="dataBlockHead">
          <h4>
            <Icon name="server" size={15} /> Databáze
          </h4>
          <div className="dataTools">
            <select
              value={table}
              onChange={(e) => setTable(e.target.value)}
              disabled={tablesLoading || tableOptions.length === 0}
            >
              {tableOptions.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name} ({item.rows})
                </option>
              ))}
            </select>
            <div className="dataSearch">
              <Icon name="search" size={15} />
              <input
                value={tableQuery}
                onChange={(e) => setTableQuery(e.target.value)}
                placeholder="Filtrovat řádky…"
              />
              {tableLoading && <Spinner size={14} />}
            </div>
          </div>
        </header>

        <div className="dataTableWrap">
          <table className="dataTable">
            <thead>
              <tr>
                {columns.map((col) => (
                  <th key={col}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} title={cell === null ? "NULL" : String(cell)}>
                      {cell === null ? <span className="dataNull">NULL</span> : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !tableLoading && <p className="dataEmpty">Žádné řádky.</p>}
        </div>

        <div className="dataPager">
          <span>
            {tableTotal === 0 ? "0" : `${tableOffset + 1}–${tableEnd}`} z {tableTotal}
          </span>
          <button
            className="btn ghost tiny"
            disabled={tableOffset === 0 || tableLoading}
            onClick={() => setTableOffset((n) => Math.max(0, n - 50))}
          >
            Zpět
          </button>
          <button
            className="btn ghost tiny"
            disabled={tableEnd >= tableTotal || tableLoading}
            onClick={() => setTableOffset((n) => n + 50)}
          >
            Další
          </button>
        </div>
      </section>
    </div>
  );
}
