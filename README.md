# Melvin

Soukromý self-hosted chat pro partu. Žádné algoritmy, žádné reklamy — jen
kanály, hlasovky, hovory, ankety a soubory na vašem vlastním serveru.

## Co umí

- **Účty** — klasické jméno + heslo (PBKDF2, 210 000 iterací), 90denní session.
  První zaregistrovaný účet je admin. Registraci chrání pozvánkový kód.
- **Kanály** — veřejné (všichni, i nově příchozí) a soukromé (jen pozvaní).
  Vlastník kanálu spravuje členy, téma a viditelnost.
- **Zprávy** — reakce, odpovědi, mazání, historie po stránkách,
  nepřečtené zprávy, indikátor psaní.
- **Hlasovky** — nahrání přímo v prohlížeči (MediaRecorder), přehrávání v chatu.
- **Hovory** — skupinový WebRTC mesh hovor v kanálu, mikrofon, kamera, ztlumení,
  zvonek pro ostatní členy.
- **Ankety** — 2–10 možností, více odpovědí, anonymní, uzavření autorem.
- **Přílohy** — fotky, videa, audio i libovolné soubory do **500 MB**
  (konfigurovatelné). Nahrávání po 4MB chuncích s možností pokračovat,
  streamované stahování s podporou HTTP Range.
- **Nastavení** — tmavý/světlý motiv, akcentní barva, hustota, velikost písma,
  zaoblení bublin, Enter/Shift+Enter, zvuk, notifikace, viditelnost online
  statusu, zobrazení chyb a log chyb ke stažení.
- **Aplikace** — web/PWA, Windows, Linux, macOS, Android a iOS přes Tauri v2
  (jeden React frontend).

## Rychlý start (Docker)

```bash
cp .env.example .env
# uprav REGISTRATION_CODE, MAX_UPLOAD_MB, ICE_SERVERS, DOMAIN
docker compose up -d --build
```

Web běží na `http://127.0.0.1:8000`. Před veřejné nasazení dej web za HTTPS
(Caddy, Nginx, Traefik, Coolify…). HTTPS je potřeba i pro mikrofon a kameru
v prohlížeči — `getUserMedia` funguje jen v secure contextu (nebo na
`localhost`).

Data (SQLite + nahrané soubory) jsou v Docker volume `melvin_data`.
Zálohuj celý volume, ne jen databázi.

## První kroky

1. Otevři web, klikni na **Vytvořit účet**.
2. Zadej pozvánkový kód z `REGISTRATION_CODE` (pokud je nastavený).
3. První účet dostane admin práva a server mu automaticky založí veřejný
   kanál `#general`.
4. Vytvoř další kanály tlačítkem **+** v levém panelu. Pro soukromý kanál
   vyber konkrétní lidi.

## Lokální vývoj

Potřeba: Go 1.24+, Bun, (volitelně) Rust pro desktop.

```bash
# terminál 1 – API
cd api
PORT=8000 DB_PATH=/tmp/melvin/melvin.db UPLOAD_DIR=/tmp/melvin/uploads \
  REGISTRATION_CODE=test123 go run .

# terminál 2 – web (Vite s proxy na :8000)
cd web
bun install
bun run dev          # http://localhost:5173
```

Produkční web server (Bun) umí servírovat build a proxyovat API i WebSocket:

```bash
cd web
bun run build
API_URL=http://localhost:8000 bun run start   # http://localhost:8000
```

### Desktop / mobil

```bash
cd desktop
bun install
bun run dev            # nativní okno (Windows/Linux/macOS)
bun run build          # instalátory
bun run android:init   # jednou, pak android:dev / android:build
bun run ios:init       # jednou na macOS, pak ios:dev / ios:build
```

Podrobnosti a systémové závislosti: [`desktop/README.md`](desktop/README.md).

## Konfigurace API

| Proměnná | Výchozí | Význam |
| --- | --- | --- |
| `PORT` | `8000` | Port API |
| `DB_PATH` | `/data/melvin.db` | SQLite databáze |
| `UPLOAD_DIR` | `/data/uploads` | Soubory a rozpracovaná nahrávání |
| `MAX_UPLOAD_MB` | `500` | Max. velikost jednoho souboru |
| `REGISTRATION_CODE` | *(prázdné)* | Pozvánka pro registraci; prázdné = otevřená registrace |
| `ICE_SERVERS` | `stun:stun.l.google.com:19302` | STUN/TURN pro hovory, oddělené čárkou. TURN s credentials: `turn:host:3478\|user\|pass` |
| `VERSION` | `0.1.0` | Verze zobrazená v nastavení |

Maximální velikost requestu WebSocketu je 256 KB (signální zprávy), samotná
data souborů jdou přes HTTP chunky.

## Jak fungují soubory

Inspirováno [`uwurl`](../uwurl):

1. `POST /api/uploads/init` → `{ id, chunkSize }`
2. `PUT /api/uploads/{id}/chunk?offset=N` pro každý 4MB kus
3. `POST /api/uploads/{id}/complete` → záznam v `attachments`
4. Zpráva s `attachmentId`; soubor se vydá přes `GET /api/files/{id}`

Rozpracovaná nahrávání se ukládají do `uploads/tmp/<id>.part`, po dokončení se
přesunou do `uploads/files/<id>`. Neaktivní uploady starší 24 h server uklidí.
Soubory jsou dostupné jen členům kanálu, kam byly poslány (nebo uploaderovi,
dokud nejsou odeslané). Podporuje `Range` (seek ve videu) a dlouhé stahování.

## Hovory

Signaling jde přes WebSocket (`call:join`, `call:offer`, `call:answer`,
`call:ice`, `call:leave`), média peer-to-peer přes WebRTC. Pro kamarády ve
stejné síti stačí STUN. Pokud se někomu spojení nedaří (symetrický NAT),
nasaď TURN (coturn) a přidej ho do `ICE_SERVERS`:

```
ICE_SERVERS=stun:stun.l.google.com:19302,turn:turn.example.com:3478|melvin|tajneheslo
```

## Architektura

```
web/        React 19 + Vite, TypeScript, vlastní CSS
  main.ts   Bun server: statické soubory + proxy /api a /ws
api/        Go 1.24+, net/http, SQLite (modernc), gorilla/websocket
desktop/    Tauri v2 obal pro Windows/Linux/macOS/Android/iOS
```

`web/` je jediný frontend — web i všechny aplikace používají stejný kód.
V Tauri se na přihlašovací obrazovce zobrazí pole pro adresu serveru
(ukládá se do localStorage).

### API přehled

- `POST /api/auth/register`, `/login`, `/logout`, `GET /api/auth/me`
- `PATCH /api/me`, `POST /api/me/password`, `GET /api/users`
- `GET/POST /api/channels`, `GET/PATCH/DELETE /api/channels/{id}`
- `POST /api/channels/{id}/leave`, `/read`, `/polls`
- `GET/POST /api/channels/{id}/messages`, `GET .../search`
- `DELETE /api/messages/{id}`, `POST /api/messages/{id}/reactions`
- `POST /api/polls/{id}/vote`, `/close`
- `POST /api/uploads/init`, `PUT /api/uploads/{id}/chunk`, `POST .../complete`
- `GET /api/files/{id}`, `GET /api/config`, `GET /healthz`
- `GET /ws?token=…`

Autentizace je `Authorization: Bearer <token>`; média a WebSocket přijímají
také `?token=` (cookie `melvin_session` funguje pro web).

## Bezpečnost a provoz

- CORS je otevřené, ale autorizace je vždy token — žádná cookie-only mutace,
  takže nehrozí CSRF.
- Hesla jsou hashovaná PBKDF2-SHA256, session tokeny v DB jen jako SHA-256.
- Rate limit na login/registraci (in-memory, pro malou partu dost).
- Doporučeno: HTTPS, silný `REGISTRATION_CODE`, zálohy volume, aktualizace
  image.
- Mazání zprávy smaže i její přílohu. Smazání kanálu smaže zprávy, ankety
  i přílohy (cascade).

## Licence

Soukromý projekt pro partu. Používej, jak potřebuješ.
