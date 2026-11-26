#!/bin/sh
# Run: sh test/hook.test.sh
# Checks that the plugin's hook sends the server only what it needs: no typed
# prompt, no folder path, no transcript path. Uses a throwaway HOME and a
# one-shot local server; touches nothing outside its temp folder.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'kill $SRV 2>/dev/null; rm -rf "$T"' EXIT
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1])')

python3 - "$PORT" "$T/body" <<'PY' &
import http.server, sys
port, out = int(sys.argv[1]), sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        open(out, "wb").write(self.rfile.read(n))
        self.send_response(200); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).handle_request()
PY
SRV=$!
sleep 0.5

mkdir -p "$T/home" "$T/project"
# A joined folder, as the plugin itself would save it.
export HOME="$T/home" CLAUDE_PROJECT_DIR="$T/project" CORKTALK_SERVER="http://127.0.0.1:$PORT"
mkdir -p "$HOME/.corktalk/folders"
f="$HOME/.corktalk/folders/$(printf '%s' "$T/project" | sed 's#[^A-Za-z0-9._-]#_#g')"
printf 'folder=%s\ncode=abcd-efgh-jkmn\nkey=ck_test\ntitle=T\nname=N\n' "$T/project" > "$f"
# Also the new-style name, if the script uses one.
nf=$(sh "$ROOT/plugin/bin/corktalk" _file "$T/project" 2>/dev/null) && [ -n "$nf" ] && cp "$f" "$nf"

printf '%s' '{"session_id":"11111111-2222-3333-4444-555555555555","transcript_path":"/Users/x/.claude/projects/p/t.jsonl","cwd":"/Users/x/secret-project","permission_mode":"default","hook_event_name":"UserPromptSubmit","prompt":"my private prompt"}' |
  sh "$ROOT/plugin/bin/corktalk" hook >/dev/null
wait $SRV 2>/dev/null

fail=0
body=$(cat "$T/body" 2>/dev/null)
[ -n "$body" ] || { echo "FAIL: hook sent nothing"; exit 1; }
for leak in "my private prompt" "secret-project" "t.jsonl" "permission_mode"; do
  case "$body" in *"$leak"*) echo "FAIL: hook sent '$leak'"; fail=1 ;; esac
done
case "$body" in *11111111-2222-3333-4444-555555555555*) ;; *) echo "FAIL: session_id missing"; fail=1 ;; esac
case "$body" in *UserPromptSubmit*) ;; *) echo "FAIL: event missing"; fail=1 ;; esac
[ $fail = 0 ] && echo "PASS: hook sends only session_id and event"

# Two folders whose names differ only in / vs _ must not share a membership file.
f1=$(sh "$ROOT/plugin/bin/corktalk" _file "/a/b_c"); f2=$(sh "$ROOT/plugin/bin/corktalk" _file "/a/b/c")
if [ "$f1" = "$f2" ]; then echo "FAIL: /a/b_c and /a/b/c share $f1"; fail=1; else echo "PASS: folders get separate files"; fi
# A file whose folder= line names another folder is not used.
mkdir -p "$T/other"
printf 'folder=/somewhere/else\nkey=ck_x\ntitle=X\nname=N\n' > "$(sh "$ROOT/plugin/bin/corktalk" _file "$T/other")"
out=$(CLAUDE_PROJECT_DIR="$T/other" sh "$ROOT/plugin/bin/corktalk" status)
case "$out" in *"not in a Corktalk room"*) echo "PASS: a file for another folder is ignored" ;; *) echo "FAIL: used another folder's file: $out"; fail=1 ;; esac

# A path that never reaches "/" (e.g. a Windows-style one) must not loop forever.
start=$(date +%s)
printf '{}' | CLAUDE_PROJECT_DIR='C:\Users\x\proj' sh "$ROOT/plugin/bin/corktalk" hook >/dev/null &
pid=$!; sleep 3
if kill -0 $pid 2>/dev/null; then kill $pid; echo "FAIL: hook loops on a Windows-style path"; fail=1; else echo "PASS: hook ends on a Windows-style path"; fi
exit $fail
