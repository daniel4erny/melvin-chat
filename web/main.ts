import type { BunRequest, Server } from "bun";
import middleware from "./static/middleware.html";
import { protect, login } from "./auth.ts";

const LIVECHAT_URL = "ws://livechat_api:8000/";

type Data = { upstream: WebSocket };

// connects to livechat_api first, it checks the cookie itself, then upgrades the client
async function livechat(req: BunRequest, server: Server<Data>) {
  const cookie = req.headers.get("cookie");
  if (!cookie) return new Response("Unauthorized", { status: 401 });

  const upstream = new WebSocket(LIVECHAT_URL, { headers: { cookie: cookie } });
  try {
    await new Promise((resolve, reject) => {
      upstream.onopen = resolve;
      upstream.onerror = reject;
    });
  } catch (err) {
    return new Response("Livechat unavailable", { status: 502 });
  }

  if (server.upgrade(req, { data: { upstream: upstream } })) return;
  upstream.close();
  return new Response("Upgrade failed", { status: 400 });
}

Bun.serve({
  port: 8000,
  routes: {
    "/healthz": new Response("ok"),
    "/middleware": middleware,
    "/api/login": { POST: login },
    "/ws": livechat,
    "/": protect("index.html"),
    "/liveChat": protect("index.html"),
  },
  websocket: {
    data: {} as Data,
    open(ws) {
      ws.data.upstream.onmessage = (event) => ws.send(event.data);
      ws.data.upstream.onclose = () => ws.close();
    },
    message(ws, message) {
      ws.data.upstream.send(message);
    },
    close(ws) {
      ws.data.upstream.close();
    },
  },
  async fetch(req) {
    // Serve Vite build assets (JS/CSS bundles with content hashes)
    const url = new URL(req.url);
    const file = Bun.file(`./dist${url.pathname}`);
    if (await file.exists()) return new Response(file);
    return new Response("Not Found", { status: 404 });
  },
});
