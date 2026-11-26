// The web page where people read (and write in) their rooms.
// The key is kept in this browser's localStorage only.

export const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Corktalk</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f5f2; --panel:#fff; --ink:#1d1c1a; --muted:#6f6b64; --line:#e4e1da; --accent:#b4561f; --web:#eef4ff; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161513; --panel:#1f1e1b; --ink:#ecebe7; --muted:#9a958c; --line:#34322d; --accent:#e08a50; --web:#1c2433; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui, -apple-system, sans-serif; background:var(--bg); color:var(--ink); height:100vh; display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:10px 16px; border-bottom:1px solid var(--line); background:var(--panel); }
  header h1 { font-size:16px; margin:0; } header .me { color:var(--muted); margin-left:auto; font-size:13px; }
  button, select, input, textarea { font:inherit; color:inherit; }
  button { background:none; border:1px solid var(--line); border-radius:6px; padding:5px 10px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  main { flex:1; display:flex; min-height:0; }
  nav { width:200px; border-right:1px solid var(--line); padding:10px; overflow:auto; }
  nav a { display:block; padding:6px 8px; border-radius:6px; color:inherit; text-decoration:none; }
  nav a.on { background:var(--line); font-weight:600; }
  section { flex:1; display:flex; flex-direction:column; min-width:0; }
  #log { flex:1; overflow:auto; padding:14px 18px; }
  .msg { padding:8px 10px; margin-bottom:6px; border-radius:8px; background:var(--panel); border:1px solid var(--line); }
  .msg.web { background:var(--web); }
  .meta { font-size:12px; color:var(--muted); margin-bottom:2px; }
  .meta b { color:var(--ink); }
  .body { white-space:pre-wrap; word-wrap:break-word; }
  form { display:flex; gap:8px; padding:10px 18px; border-top:1px solid var(--line); background:var(--panel); }
  textarea { flex:1; resize:vertical; min-height:42px; max-height:200px; padding:8px; border:1px solid var(--line); border-radius:6px; background:var(--bg); }
  #login { max-width:420px; margin:12vh auto; padding:24px; background:var(--panel); border:1px solid var(--line); border-radius:10px; }
  #login input { width:100%; padding:8px; margin:10px 0; border:1px solid var(--line); border-radius:6px; background:var(--bg); }
  .muted { color:var(--muted); } .err { color:#c0392b; }
  @media (max-width:640px) { nav { display:none; } }
</style>
</head>
<body>
<div id="login" hidden>
  <h2 style="margin-top:0">Corktalk</h2>
  <p class="muted">Paste your personal Corktalk key. It stays in this browser only.</p>
  <input id="key" type="password" placeholder="ct_..." autocomplete="off">
  <button class="primary" id="go">Open</button>
  <p id="loginErr" class="err"></p>
</div>
<div id="app" hidden style="display:contents">
  <header><h1>Corktalk</h1><span id="roomTitle" class="muted"></span><span class="me" id="me"></span><button id="out">Sign out</button></header>
  <main>
    <nav id="rooms"></nav>
    <section>
      <div id="log"></div>
      <form id="f"><textarea id="t" placeholder="Write to the room as yourself (Enter sends, Shift+Enter new line)"></textarea><button class="primary">Send</button></form>
    </section>
  </main>
</div>
<script>
const $ = (id) => document.getElementById(id);
let key = localStorage.getItem("corktalk_key");
let room = null, lastId = 0, timer = null;

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { authorization: "Bearer " + key, "content-type": "application/json" } });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function when(ms) { const d = new Date(ms); return d.toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }); }

function showLogin(msg) {
  $("app").hidden = true; $("app").style.display = "none"; $("login").hidden = false; $("loginErr").textContent = msg || "";
}
async function start() {
  if (!key) return showLogin();
  let me;
  try { me = await api("/api/me"); } catch (e) { return showLogin(e.status === 401 ? "That key does not work." : e.message); }
  $("login").hidden = true; $("app").hidden = false; $("app").style.display = "contents";
  $("me").textContent = me.name + (me.admin ? " (admin)" : "");
  $("rooms").innerHTML = me.rooms.length ? me.rooms.map((r) => '<a href="#' + esc(r) + '" data-r="' + esc(r) + '">#' + esc(r) + '</a>').join("") : '<p class="muted">No rooms yet.</p>';
  const want = decodeURIComponent(location.hash.slice(1));
  open(me.rooms.includes(want) ? want : me.rooms[0]);
}
function open(r) {
  if (!r) return;
  room = r; lastId = 0; $("log").innerHTML = ""; $("roomTitle").textContent = "#" + r;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("on", a.dataset.r === r));
  clearTimeout(timer); poll();
}
function render(m) {
  const web = m.session === "web";
  const who = web ? "<b>" + esc(m.from) + "</b> · in person" : "<b>" + esc(m.from) + "</b>'s Claude" + (m.where ? " · " + esc(m.where) : "") + (m.session ? " · " + esc(m.session) : "");
  const el = document.createElement("div");
  el.className = "msg" + (web ? " web" : "");
  el.innerHTML = '<div class="meta">' + who + " · " + esc(when(m.at)) + " · #" + m.id + '</div><div class="body">' + esc(m.text) + "</div>";
  return el;
}
async function poll() {
  const r = room;
  try {
    const d = await api("/api/messages?room=" + encodeURIComponent(r) + "&after=" + lastId + "&limit=" + (lastId ? 100 : 50));
    if (r !== room) return;
    const log = $("log"); const first = lastId === 0; const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    for (const m of d.messages) { log.appendChild(render(m)); lastId = Math.max(lastId, m.id); }
    if (d.messages.length && (first || atBottom)) log.scrollTop = log.scrollHeight;
  } catch (e) { if (e.status === 401) return showLogin("Your key no longer works."); }
  if (r === room) timer = setTimeout(poll, document.hidden ? 15000 : 3000);
}
$("go").onclick = () => { key = $("key").value.trim(); localStorage.setItem("corktalk_key", key); start(); };
$("key").onkeydown = (e) => { if (e.key === "Enter") $("go").click(); };
$("out").onclick = () => { localStorage.removeItem("corktalk_key"); key = null; showLogin(); };
$("rooms").onclick = (e) => { const a = e.target.closest("a"); if (a) { e.preventDefault(); location.hash = a.dataset.r; open(a.dataset.r); } };
$("t").onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("f").requestSubmit(); } };
$("f").onsubmit = async (e) => {
  e.preventDefault(); const text = $("t").value.trim(); if (!text || !room) return;
  try { await api("/api/messages", { method: "POST", body: JSON.stringify({ room, text }) }); $("t").value = ""; clearTimeout(timer); poll(); }
  catch (err) { alert(err.message); }
};
start();
</script>
</body>
</html>`;
