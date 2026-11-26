import { DurableObject } from "cloudflare:workers";
import { handleMcp } from "./mcp.js";
import {
  HttpError,
  cleanName,
  cleanTitle,
  cleanLabel,
  cleanBody,
  publicMessage,
  formatLine,
  introText,
  deliveryText,
  wakeText,
} from "./text.js";

const SCHEMA_VERSION = 4;
// A session that keeps being woken by the room answers by itself this many
// times at most; then messages wait until its person types again. This stops
// two Claudes from waking each other forever.
const MAX_WAKES = 5;
const MIN_WAKE_GAP_MS = 30000; // at least this long between automatic wake-ups of one session
const WAIT_MS = 25000;
const MAX_TEXT = 8000;
const HOOK_MAX_MESSAGES = 30;
const HOOK_MAX_CHARS_EACH = 2000;
const INTRO_RECENT_MS = 24 * 3600 * 1000;
const MAX_SESSIONS_PER_MEMBER = 20;
const SESSION_IDLE_DAYS = 30;
const ROOM_IDLE_DAYS = 90;
const DAY = 24 * 3600 * 1000;
const SESSION_RE = /^[A-Za-z0-9_-]{8,80}$/;

// Limits per hour: per network for room making/joining, per member for posting.
const LIMITS = { create: 20, join: 60, bad_code: 30, post: 300 };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz"; // no 0/1/i/l/o
function randomChars(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}
// A room code like "k7m2-q9xw-4hpt" (about 59 bits).
function newCode() {
  const c = randomChars(12);
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}
function newKey() {
  return "ck_" + randomChars(32);
}

// Accepts a code, or a whole room link, in any case and with or without dashes.
function normalizeCode(input) {
  let s = String(input || "").trim().toLowerCase();
  const m = s.match(/\/r\/([a-z0-9-]+)/);
  if (m) s = m[1];
  s = s.replace(/[^a-z0-9]/g, "");
  if (s.length !== 12) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function bearer(request) {
  const m = (request.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function readBody(request) {
  const type = request.headers.get("content-type") || "";
  let b;
  if (type.includes("application/x-www-form-urlencoded")) b = Object.fromEntries(new URLSearchParams(await request.text()));
  else b = await request.json().catch(() => ({}));
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

// Limits are counted per network: an IPv6 address by its /64, IPv4 as is.
function network(request) {
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") + "::/64" : ip;
}

const KNOWN = new Set(["/mcp", "/hook", "/api/rooms", "/api/peek", "/api/join", "/api/room", "/api/messages", "/api/new-link", "/api/me"]);

export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.waiting = new Map(); // room id -> Set of functions to call when a message arrives
    this.sessionWaiter = new Map(); // session hash -> function that ends that session's current wait
    this.alarmSet = false;
    this.migrate();
  }

  migrate() {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)");
      const v = Number(this.sql.exec("SELECT v FROM meta WHERE k = 'schema'").toArray()[0]?.v || 0);
      if (v >= SCHEMA_VERSION) return;
      if (v < 2) {
        // Version 1 was the invite-only test build; nothing in it is kept.
        for (const t of ["members", "rooms", "room_members", "messages", "cursors", "presence", "sessions", "limits"]) {
          this.sql.exec(`DROP TABLE IF EXISTS ${t}`);
        }
        this.sql.exec(`
          CREATE TABLE rooms (
            id INTEGER PRIMARY KEY,
            title TEXT NOT NULL,
            code_hash TEXT NOT NULL UNIQUE,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE members (
            id INTEGER PRIMARY KEY,
            room_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            kind TEXT NOT NULL,              -- 'claude' (a Claude Code folder) or 'web' (a browser)
            label TEXT,                      -- folder name for 'claude'
            key_hash TEXT NOT NULL UNIQUE,   -- 'left:…' once the member left or was removed
            is_owner INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            last_seen INTEGER
          );
          CREATE INDEX members_room ON members (room_id);
          CREATE TABLE sessions (
            session_hash TEXT PRIMARY KEY,   -- sha256 of the Claude Code session id
            tag TEXT NOT NULL,               -- short public tag shown to others
            member_id INTEGER NOT NULL,
            last_id INTEGER NOT NULL,        -- last message this session has been shown
            last_seen INTEGER NOT NULL,
            wakes INTEGER NOT NULL DEFAULT 0 -- times woken by the room since its person last typed
          );
          CREATE INDEX sessions_member ON sessions (member_id);
          CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id INTEGER NOT NULL,
            member_id INTEGER NOT NULL,
            tag TEXT,
            body TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX messages_room ON messages (room_id, id);
          CREATE TABLE limits (
            ip TEXT NOT NULL, what TEXT NOT NULL, hour INTEGER NOT NULL, n INTEGER NOT NULL,
            PRIMARY KEY (ip, what, hour)
          );
        `);
      } else if (v === 2) {
        this.sql.exec("ALTER TABLE sessions ADD COLUMN wakes INTEGER NOT NULL DEFAULT 0");
      }
      // Version 4: a read position per member (so a new session starts where the
      // folder left off) and the time of each session's last automatic wake-up.
      this.sql.exec("ALTER TABLE members ADD COLUMN last_id INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("ALTER TABLE sessions ADD COLUMN last_wake INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)", String(SCHEMA_VERSION));
    });
  }

  // ---------- cleanup (daily) ----------

  async ensureAlarm() {
    if (this.alarmSet) return;
    this.alarmSet = true;
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + DAY);
  }

  async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE last_seen < ?", now - SESSION_IDLE_DAYS * DAY);
    // A room is idle when nothing happened in it for ROOM_IDLE_DAYS: no message, no member seen.
    const idle = this.sql
      .exec(
        `SELECT r.id FROM rooms r
         WHERE MAX(r.created_at,
                   COALESCE((SELECT MAX(created_at) FROM messages WHERE room_id = r.id), 0),
                   COALESCE((SELECT MAX(last_seen) FROM members WHERE room_id = r.id), 0)) < ?`,
        now - ROOM_IDLE_DAYS * DAY,
      )
      .toArray();
    for (const r of idle) this.removeRoom(r.id);
    await this.ctx.storage.setAlarm(now + DAY);
  }

  // ---------- limits ----------

  limit(key, what) {
    const hour = Math.floor(Date.now() / 3600000);
    this.sql.exec("DELETE FROM limits WHERE hour < ?", hour - 1);
    const n = this.sql
      .exec(
        `INSERT INTO limits (ip, what, hour, n) VALUES (?, ?, ?, 1)
         ON CONFLICT (ip, what, hour) DO UPDATE SET n = n + 1 RETURNING n`,
        key, what, hour,
      )
      .one().n;
    if (n > LIMITS[what]) {
      throw new HttpError(429, what === "post" ? "Too many messages from this member. Please wait a while." : "Too many tries from your network. Please wait an hour.");
    }
  }

  // ---------- identity ----------

  async memberByKey(request) {
    const key = bearer(request);
    if (!key) return null;
    const m = this.sql
      .exec(
        `SELECT m.id, m.room_id, m.name, m.kind, m.label, m.is_owner, m.last_id, r.title
         FROM members m JOIN rooms r ON r.id = m.room_id WHERE m.key_hash = ?`,
        await sha256(key),
      )
      .toArray()[0];
    if (m) this.sql.exec("UPDATE members SET last_seen = ? WHERE id = ?", Date.now(), m.id);
    return m || null;
  }

  async session(sessionId) {
    if (!sessionId || !SESSION_RE.test(String(sessionId))) {
      throw new HttpError(400, "Missing session_id. It is shown in the [Corktalk] note when the session connects; pass it exactly.");
    }
    const row = this.sql
      .exec(
        `SELECT s.session_hash, s.tag, s.last_id, m.id AS member_id, m.room_id, m.name, m.label, m.is_owner, r.title
         FROM sessions s JOIN members m ON m.id = s.member_id JOIN rooms r ON r.id = m.room_id
         WHERE s.session_hash = ? AND m.key_hash NOT LIKE 'left:%'`,
        await sha256(String(sessionId)),
      )
      .toArray()[0];
    if (!row) {
      throw new HttpError(
        404,
        "This session is not connected to a Corktalk room (or the session_id is wrong). The user can join with /corktalk:join <room link>.",
      );
    }
    this.sql.exec("UPDATE sessions SET last_seen = ? WHERE session_hash = ?", Date.now(), row.session_hash);
    return row;
  }

  // ---------- rooms and members ----------

  async roomByCode(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    return this.sql.exec("SELECT id, title FROM rooms WHERE code_hash = ?", await sha256(c)).toArray()[0] || null;
  }

  // Names are unique per room (ignoring case and people who left), so nobody can pose as someone else.
  async addMember(roomId, name, kind, label, isOwner) {
    const taken = this.sql
      .exec("SELECT name FROM members WHERE room_id = ? AND key_hash NOT LIKE 'left:%'", roomId)
      .toArray()
      .some((r) => r.name.toLowerCase() === name.toLowerCase());
    if (taken) {
      throw new HttpError(409, `Someone in this room already uses the name "${name}". Please pick another, for example "${name} (laptop)".`);
    }
    const key = newKey();
    this.sql.exec(
      "INSERT INTO members (room_id, name, kind, label, key_hash, is_owner, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      roomId, name, kind, kind === "claude" ? cleanLabel(label) : null, await sha256(key), isOwner ? 1 : 0, Date.now(), Date.now(),
    );
    return key;
  }

  people(roomId, withIds = false) {
    const rows = this.sql
      .exec(
        `SELECT id, name, kind, label, is_owner, last_seen FROM members
         WHERE room_id = ? AND key_hash NOT LIKE 'left:%' ORDER BY name COLLATE NOCASE, kind`,
        roomId,
      )
      .toArray();
    return rows.map((r) => ({
      ...(withIds ? { id: r.id } : {}),
      name: r.name,
      kind: r.kind,
      where: r.kind === "claude" ? r.label : "browser",
      owner: !!r.is_owner,
      last_seen: r.last_seen,
    }));
  }

  retire(memberId) {
    this.sql.exec("DELETE FROM sessions WHERE member_id = ?", memberId);
    // Their past messages stay; the key stops working.
    this.sql.exec("UPDATE members SET key_hash = ? WHERE id = ?", "left:" + crypto.randomUUID(), memberId);
  }

  removeRoom(id) {
    this.sql.exec("DELETE FROM sessions WHERE member_id IN (SELECT id FROM members WHERE room_id = ?)", id);
    this.sql.exec("DELETE FROM messages WHERE room_id = ?", id);
    this.sql.exec("DELETE FROM members WHERE room_id = ?", id);
    this.sql.exec("DELETE FROM rooms WHERE id = ?", id);
  }

  // ---------- messages ----------

  async post(member, body, tag) {
    body = cleanBody(body);
    if (!body) throw new HttpError(400, "Message text is empty.");
    if (body.length > MAX_TEXT) throw new HttpError(400, `Message is longer than ${MAX_TEXT} characters.`);
    const memberId = member.member_id ?? member.id;
    this.limit(`m:${memberId}`, "post");
    // Never let a session id (the key to post as a Claude) be posted into the room.
    const ids = body.match(/[A-Za-z0-9_-]{20,80}/g) || [];
    for (const id of ids.slice(0, 50)) {
      const hit = this.sql
        .exec(
          `SELECT 1 FROM sessions s JOIN members m ON m.id = s.member_id WHERE s.session_hash = ? AND m.room_id = ?`,
          await sha256(id), member.room_id,
        )
        .toArray().length;
      if (hit) throw new HttpError(400, "This message contains a Corktalk session_id, which must stay private. It was not sent.");
    }
    const now = Date.now();
    const row = this.sql
      .exec(
        "INSERT INTO messages (room_id, member_id, tag, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
        member.room_id, memberId, tag || null, body, now,
      )
      .one();
    const set = this.waiting.get(member.room_id);
    if (set) for (const wake of [...set]) wake();
    return { id: row.id, at: now };
  }

  messages(roomId, { after = 0, before = null, limit = 20 } = {}) {
    limit = Math.max(1, Math.min(100, Number(limit) || 20));
    const base = `SELECT m.id, m.tag, m.body, m.created_at, mem.name, mem.kind, mem.label
                  FROM messages m JOIN members mem ON mem.id = m.member_id WHERE m.room_id = ?`;
    let rows;
    if (Number(before) > 0) rows = this.sql.exec(`${base} AND m.id < ? ORDER BY m.id DESC LIMIT ?`, roomId, Number(before), limit).toArray().reverse();
    else if (Number(after) > 0) rows = this.sql.exec(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, roomId, Number(after), limit).toArray();
    else rows = this.sql.exec(`${base} ORDER BY m.id DESC LIMIT ?`, roomId, limit).toArray().reverse();
    return rows.map(publicMessage);
  }

  latestId(roomId) {
    return this.sql.exec("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room_id = ?", roomId).one().id;
  }

  // Messages after `lastId` that this session did not send itself (one more than shown, to tell if more wait).
  unread(roomId, lastId, tag) {
    return this.sql
      .exec(
        `SELECT m.id, m.tag, m.body, m.created_at, mem.name, mem.kind, mem.label
         FROM messages m JOIN members mem ON mem.id = m.member_id
         WHERE m.room_id = ? AND m.id > ? AND COALESCE(m.tag, '') <> ?
         ORDER BY m.id ASC LIMIT ?`,
        roomId, lastId, tag, HOOK_MAX_MESSAGES + 1,
      )
      .toArray();
  }

  // Marks rows as shown to this session (and to its folder), and returns them as text.
  deliver(rows, hash, memberId, wake = false) {
    const shown = rows.slice(0, HOOK_MAX_MESSAGES);
    const last = shown[shown.length - 1].id;
    const now = Date.now();
    if (wake) this.sql.exec("UPDATE sessions SET last_id = ?, wakes = wakes + 1, last_wake = ?, last_seen = ? WHERE session_hash = ?", last, now, now, hash);
    else this.sql.exec("UPDATE sessions SET last_id = MAX(last_id, ?) WHERE session_hash = ?", last, hash);
    this.sql.exec("UPDATE members SET last_id = MAX(last_id, ?) WHERE id = ?", last, memberId);
    let lines = shown.map((m) => formatLine(publicMessage(m), HOOK_MAX_CHARS_EACH)).join("\n");
    if (rows.length > HOOK_MAX_MESSAGES) lines += `\n(More are waiting: use read_messages with after=${last}.)`;
    return lines;
  }

  async newLink(member, origin) {
    if (!member.is_owner) throw new HttpError(403, "Only the person who made the room can replace its link.");
    const code = newCode();
    this.sql.exec("UPDATE rooms SET code_hash = ? WHERE id = ?", await sha256(code), member.room_id);
    return { code, link: `${origin}/r/${code}` };
  }

  // ---------- HTTP ----------

  async fetch(request) {
    try {
      await this.ensureAlarm();
      return await this.route(request);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Something went wrong on the Corktalk server." }, 500);
    }
  }

  async route(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const origin = url.origin;

    if (path === "/mcp") return handleMcp(this, request);
    const memberPath = /^\/api\/members\/\d+$/.test(path);
    if (!KNOWN.has(path) && !memberPath) return json({ error: "Not found" }, 404);

    // Make a room. The maker joins it too (a browser, or a Claude folder from the plugin).
    if (path === "/api/rooms" && method === "POST") {
      this.limit(network(request), "create");
      const b = await readBody(request);
      const title = cleanTitle(b.title);
      const name = cleanName(b.name);
      const code = newCode();
      const room = this.sql
        .exec("INSERT INTO rooms (title, code_hash, created_at) VALUES (?, ?, ?) RETURNING id", title, await sha256(code), Date.now())
        .one();
      const kind = b.kind === "claude" ? "claude" : "web";
      const key = await this.addMember(room.id, name, kind, b.label, true);
      return reply(url, { code, link: `${origin}/r/${code}`, title, name, key });
    }

    // Is this a real room? (Used by the room page before asking for a name.)
    if (path === "/api/peek" && method === "GET") {
      const room = await this.roomByCode(url.searchParams.get("code"));
      if (!room) {
        this.limit(network(request), "bad_code");
        return json({ error: "No room with this link. Check it, or ask for a new one." }, 404);
      }
      return json({ title: room.title, people: this.people(room.id).length });
    }

    // Join with a room link or code. kind=claude for a Claude Code folder, web for a browser.
    // replace_key: this device's previous key in the same room (a rejoin), retired first.
    if (path === "/api/join" && method === "POST") {
      this.limit(network(request), "join");
      const b = await readBody(request);
      const room = await this.roomByCode(b.code);
      if (!room) {
        this.limit(network(request), "bad_code");
        throw new HttpError(404, "No room with this link. Check it, or ask for a new one.");
      }
      const name = cleanName(b.name);
      let keepOwner = false;
      if (b.replace_key) {
        const old = this.sql
          .exec("SELECT id, room_id, is_owner FROM members WHERE key_hash = ?", await sha256(String(b.replace_key)))
          .toArray()[0];
        if (old && old.room_id === room.id) {
          this.retire(old.id);
          keepOwner = !!old.is_owner; // rejoining from the room maker's folder keeps the maker's rights
        }
      }
      const kind = b.kind === "claude" ? "claude" : "web";
      const key = await this.addMember(room.id, name, kind, b.label, keepOwner);
      return reply(url, { title: room.title, name, key, code: normalizeCode(b.code) });
    }

    // Everything below needs a member key.
    const member = await this.memberByKey(request);
    if (!member) return json({ error: "This device is not in the room (its key is missing, wrong, or was removed)." }, 401);

    if (path === "/hook" && method === "POST") return this.hook(member, request);

    if (path === "/api/room" && method === "GET") {
      return json({ title: member.title, me: member.name, owner: !!member.is_owner, people: this.people(member.room_id, !!member.is_owner) });
    }
    if (path === "/api/messages" && method === "GET") {
      return json({
        messages: this.messages(member.room_id, {
          after: url.searchParams.get("after"),
          before: url.searchParams.get("before"),
          limit: url.searchParams.get("limit") || 50,
        }),
      });
    }
    if (path === "/api/messages" && method === "POST") {
      const b = await readBody(request);
      return json(await this.post(member, b.text, null));
    }
    if (path === "/api/new-link" && method === "POST") return reply(url, await this.newLink(member, origin));
    if (path === "/api/room" && method === "DELETE") {
      if (!member.is_owner) throw new HttpError(403, "Only the person who made the room can delete it.");
      this.removeRoom(member.room_id);
      return reply(url, { deleted: true });
    }
    if (path === "/api/me" && method === "DELETE") {
      this.retire(member.id);
      return reply(url, { left: true });
    }
    // The room's maker removes someone (by member id, from /api/room).
    if (memberPath && method === "DELETE") {
      if (!member.is_owner) throw new HttpError(403, "Only the person who made the room can remove people.");
      const id = Number(path.split("/").pop());
      const target = this.sql.exec("SELECT id FROM members WHERE id = ? AND room_id = ? AND key_hash NOT LIKE 'left:%'", id, member.room_id).toArray()[0];
      if (!target) throw new HttpError(404, "No such person in this room.");
      if (target.id === member.id) throw new HttpError(400, "Use Leave to leave the room yourself.");
      this.retire(target.id);
      return json({ removed: true });
    }

    return json({ error: "Not found" }, 404);
  }

  // Called by the plugin's hooks (SessionStart, UserPromptSubmit) and by its
  // background waiter (CorktalkWait) with { session_id, hook_event_name, source }.
  // Whatever we answer is put in front of Claude.
  async hook(member, request) {
    const input = await readBody(request);
    const event = String(input.hook_event_name || "");
    const sid = String(input.session_id || "");
    const valid = member.kind === "claude" && SESSION_RE.test(sid);
    if (event === "CorktalkWait") {
      // A bad wait is refused at once; the plugin backs off on errors.
      if (!valid) return text("Not a Claude session of this room.", 400);
      return this.wait(member, await sha256(sid));
    }
    if (!valid) return text("");
    const hash = await sha256(sid);
    const now = Date.now();

    let s = this.sql.exec("SELECT tag, last_id, member_id, last_wake FROM sessions WHERE session_hash = ?", hash).toArray()[0];
    if (s && s.member_id !== member.id) {
      // The session belongs to someone else's membership. Only take it over if that one is gone.
      const owner = this.sql.exec("SELECT 1 FROM members WHERE id = ? AND key_hash NOT LIKE 'left:%'", s.member_id).toArray()[0];
      if (owner) return text("");
    }
    const isNew = !s || s.member_id !== member.id;
    if (isNew) {
      const tag = hash.slice(0, 6);
      // A new session starts where this folder left off; a first-time folder starts now.
      const start = member.last_id > 0 ? member.last_id : this.latestId(member.room_id);
      this.sql.exec(
        `INSERT INTO sessions (session_hash, tag, member_id, last_id, last_seen, wakes, last_wake) VALUES (?, ?, ?, ?, ?, 0, 0)
         ON CONFLICT (session_hash) DO UPDATE SET member_id = excluded.member_id, last_id = excluded.last_id,
           last_seen = excluded.last_seen, wakes = 0, last_wake = 0`,
        hash, tag, member.id, start, now,
      );
      // Keep at most MAX_SESSIONS_PER_MEMBER sessions per member.
      this.sql.exec(
        `DELETE FROM sessions WHERE member_id = ? AND session_hash NOT IN
           (SELECT session_hash FROM sessions WHERE member_id = ? ORDER BY last_seen DESC LIMIT ?)`,
        member.id, member.id, MAX_SESSIONS_PER_MEMBER,
      );
      s = { tag, last_id: start, member_id: member.id, last_wake: 0 };
    } else {
      this.sql.exec("UPDATE sessions SET last_seen = ? WHERE session_hash = ?", now, hash);
    }

    if (event === "SessionStart") this.sql.exec("UPDATE sessions SET wakes = 0 WHERE session_hash = ?", hash);
    // The person typed: the session may be woken by the room again. (A prompt right
    // after an automatic wake-up is that wake-up's own turn, not the person.)
    if (event === "UserPromptSubmit" && now - s.last_wake > 3000) this.sql.exec("UPDATE sessions SET wakes = 0 WHERE session_hash = ?", hash);

    const rows = this.unread(member.room_id, s.last_id, s.tag);

    if (isNew || event === "SessionStart") {
      const others = [...new Set(this.people(member.room_id).map((p) => p.name).filter((n) => n !== member.name))];
      let recent = "";
      if (rows.length) {
        recent = `Unread messages in the room:\n` + this.deliver(rows, hash, member.id);
      } else if (isNew && member.last_id === 0) {
        // First time this folder connects: a little recent context, already read.
        const ctx = this.messages(member.room_id, { limit: 5 }).filter((m) => m.at > now - INTRO_RECENT_MS);
        if (ctx.length) recent = `Recent messages in the room (for context):\n` + ctx.map((m) => formatLine(m, HOOK_MAX_CHARS_EACH)).join("\n");
        this.sql.exec("UPDATE members SET last_id = MAX(last_id, ?) WHERE id = ?", this.latestId(member.room_id), member.id);
      }
      return text(introText({ roomTitle: member.title, userName: member.name, sessionId: sid, others, recent }));
    }

    if (!rows.length) {
      // Move past this session's own messages too.
      const last = this.latestId(member.room_id);
      if (last > s.last_id) this.sql.exec("UPDATE sessions SET last_id = ? WHERE session_hash = ?", last, hash);
      return text("");
    }
    return text(deliveryText(member.title, this.deliver(rows, hash, member.id)));
  }

  // Long poll for the plugin's background waiter. Answers with new messages as
  // soon as there are any (and counts it as a wake), or empty after WAIT_MS.
  async wait(member, hash) {
    // One wait per session: a newer one ends the older.
    this.sessionWaiter.get(hash)?.();
    const load = () =>
      this.sql.exec("SELECT tag, last_id, wakes, last_wake FROM sessions WHERE session_hash = ? AND member_id = ?", hash, member.id).toArray()[0];

    let s = load();
    if (!s || s.wakes >= MAX_WAKES) {
      await pause(s ? WAIT_MS : 3000);
      return text("");
    }
    // Leave at least MIN_WAKE_GAP_MS between automatic wake-ups.
    const gap = s.last_wake + MIN_WAKE_GAP_MS - Date.now();
    if (gap > 0) {
      await pause(Math.min(gap, WAIT_MS));
      return text("");
    }
    let rows = this.unread(member.room_id, s.last_id, s.tag);
    if (!rows.length) {
      let set = this.waiting.get(member.room_id);
      if (!set) this.waiting.set(member.room_id, (set = new Set()));
      let done, timer;
      await new Promise((resolve) => {
        done = resolve;
        set.add(done);
        this.sessionWaiter.set(hash, done);
        timer = setTimeout(done, WAIT_MS);
      });
      clearTimeout(timer);
      set.delete(done);
      if (!set.size) this.waiting.delete(member.room_id);
      if (this.sessionWaiter.get(hash) === done) this.sessionWaiter.delete(hash);
      s = load();
      if (!s || s.wakes >= MAX_WAKES) return text("");
      rows = this.unread(member.room_id, s.last_id, s.tag);
      if (!rows.length) return text("");
    }
    const lines = this.deliver(rows, hash, member.id, true);
    const left = MAX_WAKES - s.wakes - 1;
    const extra = left <= 0 ? `\n(This was the last automatic wake-up until ${member.name} types again; further messages will wait for them.)` : "";
    return text(wakeText(member.title, member.name, lines, extra));
  }
}

// The shell script in the plugin cannot read JSON, so it asks for key=value lines.
function reply(url, data) {
  if (url.searchParams.get("format") === "sh") {
    return text(
      Object.entries(data)
        .map(([k, v]) => `${k}=${String(v).replace(/[\r\n]/g, " ")}`)
        .join("\n") + "\n",
    );
  }
  return json(data);
}

export { HttpError };
