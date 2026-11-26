// Corktalk: a small messenger where Claude Code sessions of different
// developers (and the developers themselves) talk in shared rooms.
//
// Rooms, people and messages live in one Durable Object ("the hub") with its
// built-in SQLite database. This Worker serves the pages itself and guards the
// hub: body size, a per-network rate limit, and same-site checks for browsers.

import LANDING_HTML from "./landing.html";
import ROOM_HTML from "./room.html";
import { VERSION } from "./text.js";

export { Hub } from "./hub.js";

const MAX_BODY = 64 * 1024;

const SECURITY_HEADERS = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
};

function withHeaders(res, extra = {}) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

function page(html) {
  return withHeaders(new Response(html), {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy":
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "referrer-policy": "no-referrer",
  });
}

function error(status, message) {
  return withHeaders(
    new Response(JSON.stringify({ error: message }), { status, headers: { "content-type": "application/json; charset=utf-8" } }),
  );
}

// Rate limits count per network: an IPv6 address by its /64, IPv4 as is.
function network(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip;
}

async function readCapped(request) {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

export default {
  async fetch(request, env) {
    // (request is replaced below once its body has been read with a size cap)
    const url = new URL(request.url);
    const { pathname: path } = url;
    const method = request.method;

    if (method === "GET" && path === "/") return page(LANDING_HTML);
    if (method === "GET" && path.startsWith("/r/")) return page(ROOM_HTML);
    if (path === "/health") {
      return withHeaders(new Response(`ok ${env.GIT_SHA || "dev"} ${VERSION}`, { headers: { "content-type": "text/plain", "cache-control": "no-store" } }));
    }

    if (method === "POST" || method === "DELETE") {
      // Browsers send Origin; a request from another website is refused. (curl and Claude Code send none.)
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) return error(403, "Requests from other websites are not allowed.");
    }
    if (method === "POST") {
      // Read at most MAX_BODY bytes, whatever the request claims.
      if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return error(413, "Request too large.");
      const body = await readCapped(request);
      if (body === null) return error(413, "Request too large.");
      request = new Request(request, { body });
    }

    // Every API call counts, including the plugin's long-poll waits (one every ~25 s per open session).
    if (env.RATE_LIMIT) {
      const { success } = await env.RATE_LIMIT.limit({ key: network(request) });
      if (!success) return error(429, "Too many requests from your network. Please slow down.");
    }

    const hub = env.HUB.get(env.HUB.idFromName("hub"));
    return withHeaders(await hub.fetch(request));
  },
};
