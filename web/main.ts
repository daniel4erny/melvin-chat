// Melvin web server: serves the Vite build and proxies /api + /ws to the Go API.
// Bun is only a thin front door here; all app logic lives in the API.

import type { ServerWebSocket } from "bun";

const API_URL = (process.env.API_URL ?? "http://localhost:8000").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 8000);
const HOST = process.env.HOST ?? "0.0.0.0";
const DIST = process.env.DIST_DIR ?? "./dist";

type SocketData = {
  target: string;
  upstream: WebSocket | null;
  queue: (string | ArrayBuffer)[];
  ready: boolean;
};


function indexFile() {
  return new Response(Bun.file(`${DIST}/index.html`), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

async function serveStatic(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/index.html") return indexFile();

  const safePath = pathname.replace(/\.\./g, "");
  const file = Bun.file(`${DIST}${safePath}`);
  if (await file.exists()) {
    const headers: Record<string, string> = {};
    if (safePath.startsWith("/assets/")) {
      // Vite asset names contain a content hash, safe to cache forever.
      headers["Cache-Control"] = "public, max-age=31536000, immutable";
    } else if (safePath.endsWith(".webmanifest")) {
      headers["Content-Type"] = "application/manifest+json";
      headers["Cache-Control"] = "no-cache";
    }
    return new Response(file, { headers });
  }

  const acceptsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
  if (acceptsHtml && !pathname.includes(".")) return indexFile();

  return new Response("Not Found", { status: 404 });
}

async function proxyApi(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = `${API_URL}${url.pathname}${url.search}`;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("connection");
  headers.delete("upgrade");
  headers.delete("accept-encoding"); // keep Content-Length honest when streaming

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
    init.body = request.body;
    init.duplex = "half";
  }

  const upstream = await fetch(target, init);
  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.delete("connection");
  responseHeaders.delete("transfer-encoding");

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function openUpstream(ws: ServerWebSocket<SocketData>) {
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(ws.data.target);
  } catch (err) {
    console.error("WS: cannot connect to API", err);
    ws.close();
    return;
  }
  upstream.binaryType = "arraybuffer";
  ws.data.upstream = upstream;

  upstream.onopen = () => {
    ws.data.ready = true;
    for (const pending of ws.data.queue) ws.send(pending);
    ws.data.queue = [];
  };
  upstream.onmessage = (event) => {
    if (typeof event.data === "string") ws.send(event.data);
    else if (event.data instanceof ArrayBuffer) ws.send(new Uint8Array(event.data));
    else if (event.data instanceof Blob) {
      void event.data.arrayBuffer().then((buf) => ws.send(new Uint8Array(buf)));
    }
  };
  upstream.onclose = () => {
    ws.data.ready = false;
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
  upstream.onerror = () => {
    try {
      ws.close();
    } catch {
      // already closed
    }
  };
}

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(request, srv) {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return new Response("ok", { headers: { "Cache-Control": "no-store" } });
    }

    if (url.pathname === "/ws" || url.pathname.startsWith("/ws/")) {
      const target = `${API_URL.replace(/^http/, "ws")}/ws${url.search}`;
      const ok = srv.upgrade(request, {
        data: { target, upstream: null, queue: [], ready: false },
      });
      if (ok) return undefined;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (url.pathname.startsWith("/api/")) {
      try {
        return await proxyApi(request);
      } catch (err) {
        console.error("API proxy error:", err);
        return Response.json(
          { error: "API není dostupné. Zkontroluj, že běží server." },
          { status: 502 },
        );
      }
    }

    return serveStatic(request);
  },
  websocket: {
    open(ws) {
      openUpstream(ws);
    },
    message(ws, message) {
      const data = ws.data;
      if (data.ready && data.upstream?.readyState === WebSocket.OPEN) {
        data.upstream.send(message);
      } else if (typeof message === "string") {
        data.queue.push(message);
      } else if (message instanceof ArrayBuffer) {
        data.queue.push(message);
      }
      if (data.queue.length > 256) {
        // client spamming before upstream is ready; drop the socket
        ws.close();
      }
    },
    close(ws) {
      ws.data.upstream?.close();
      ws.data.upstream = null;
      ws.data.queue = [];
    },
  },
});

console.log(`Melvin web on http://${HOST}:${server.port} → API ${API_URL}`);
