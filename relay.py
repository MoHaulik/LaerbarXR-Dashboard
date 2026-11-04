#!/usr/bin/env python3
"""
LærbarXR Relay: lokal relay uden afhængigheder, til live-overvågning på
skolens eget netværk. Alternativ til cloud-relayet (cloud-relay/).

Dashboard og Player er statiske sider og kan ikke modtage data fra et headset.
Dette script giver dem et fælles punkt på det lokale net:
  1. Dashboard (denne mappe) på        http://<ip>:8420/
  2. Player (mappen ved siden af) på    http://<ip>:8420/player/
  3. Et lille JSON-API under /api/*, som begge sider bruger.

Kør fra Dashboard-mappen med LaerbarXR-Player klonet ved siden af:

    python3 relay.py

På samme Wi-Fi:
  - Lærerens computer åbner   http://<computer-ip>:8420/
  - Hvert headset åbner       http://<computer-ip>:8420/player/

Kræver kun Python 3. Tilstanden ligger i hukommelsen under timen; afsluttede
resultater gemmes også i ./results/, så et nedbrud ikke mister noget.

Ikke en offentlig webserver. Uden TEACHER_KEY er der ingen adgangskontrol,
så porten må ikke eksponeres mod internettet.
"""

import json
import mimetypes
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

HOST = "0.0.0.0"
PORT = int(os.environ.get("LXR_RELAY_PORT", "8420"))

DASHBOARD_DIR = os.path.dirname(os.path.abspath(__file__))
# Player-mappen ved siden af, eller `python3 relay.py /sti/til/LaerbarXR-Player`
PLAYER_DIR = os.path.abspath(
    sys.argv[1] if len(sys.argv) > 1 else os.path.join(DASHBOARD_DIR, "..", "LaerbarXR-Player")
)
RESULTS_DIR = os.path.join(DASHBOARD_DIR, "results")

# Headsets uden heartbeat i så lang tid vises som offline.
ONLINE_TIMEOUT_SEC = 12

# ... og efter så lang tid glemmes de helt, så en relay der kører hele dagen
# ikke blander gamle gennemløb ind i tællingen.
FORGET_TIMEOUT_SEC = 6 * 3600

# Resultater gemmes i 7 dage, som i cloud-relayet. Kopierne i ./results/ er
# lærerens egen backup og røres ikke.
RESULT_RETENTION_SEC = 7 * 24 * 3600

# Valgfri lærernøgle, som TEACHER_KEY i cloud-relayet: når den er sat, kræver
# læsning af resultater/tilstand og afsendelse af kommandoer ?key=<nøgle>.
# Headsets skal aldrig bruge den.
TEACHER_KEY = os.environ.get("LXR_TEACHER_KEY", "")

# ---------------------------------------------------------------------------
# Tilstand i hukommelsen bag én lås. 99 headsets er ingen belastning.
# ---------------------------------------------------------------------------
_lock = threading.Lock()
STATE = {
    "headsets": {},   # headsetId -> {..seneste heartbeat.., lastSeen}
    "commands": [],   # kun tilføjelser: {id, scope, target, action, scenario, ts}
    "results": [],    # (seq, saved_at, *_eval.json), ryddes efter RESULT_RETENTION_SEC
    "last_result_seq": 0,
    "next_command_id": 1,
}


def _now():
    return time.time()


def _prune_results():
    """Fjern resultater ældre end oprydningsvinduet. Kalderen holder _lock."""
    cutoff = _now() - RESULT_RETENTION_SEC
    STATE["results"] = [r for r in STATE["results"] if r[1] >= cutoff]


def _prune_stale(headsets):
    """Markerer stille headsets som offline i stedet for at fjerne dem, så
    læreren kan se "sidst set for 30 s siden". Headsets ældre end
    FORGET_TIMEOUT_SEC slettes dog fra den givne dict (ændrer STATE)."""
    out = {}
    now = _now()
    for hid, h in list(headsets.items()):
        age = now - h.get("lastSeen", 0)
        if age > FORGET_TIMEOUT_SEC:
            del headsets[hid]
            continue
        h2 = dict(h)
        h2["online"] = age <= ONLINE_TIMEOUT_SEC
        out[hid] = h2
    return out


def _headset_key(body):
    return "%s|%s" % (body.get("deviceId") or "", body.get("headsetId") or "Unnamed headset")


def _clean_answers(a):
    # Samme format som cloud-relayet: [{n: nodeId, c: 1|0, a: [svarindeks]}], første
    # svar pr. spørgsmål, til Dashboardets live-tal pr. spørgsmål.
    if not isinstance(a, list):
        return []
    out = []
    for x in a[:100]:
        if isinstance(x, dict) and isinstance(x.get("n"), str):
            picks = x.get("a") if isinstance(x.get("a"), list) else []
            picks = [i for i in picks if isinstance(i, int) and not isinstance(i, bool) and 0 <= i < 100][:20]
            out.append({"n": x["n"][:80], "c": 1 if x.get("c") else 0, "a": picks})
    return out


def _int(qs, name):
    try:
        return int((qs.get(name) or ["0"])[0] or "0")
    except ValueError:
        return 0


class Handler(BaseHTTPRequestHandler):
    server_version = "LXRRelay/1.0"

    # Kortere log (metode, sti og status).
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # -- hjælpere --------------------------------------------------------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def _serve_static(self, root, url_path):
        # url_path er uden mount-præfiks. Ingen Range-understøttelse; det er
        # små lokale sider, og Player indlæser selv medierne via JSZip.
        rel = url_path.lstrip("/")
        if rel == "":
            rel = "index.html"
        # Værn mod path traversal.
        full = os.path.normpath(os.path.join(root, rel))
        root_n = os.path.normpath(root)
        if full != root_n and not full.startswith(root_n + os.sep):
            self.send_error(403, "Forbidden")
            return
        if not os.path.isfile(full):
            self.send_error(404, "Not found")
            return
        ctype, _ = mimetypes.guess_type(full)
        if full.endswith(".mp4"):
            ctype = "video/mp4"
        elif full.endswith(".webm"):
            ctype = "video/webm"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype or "application/octet-stream")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(data)

    # -- routing ----------------------------------------------------------
    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def _teacher_ok(self, qs):
        return not TEACHER_KEY or (qs.get("key") or [""])[0] == TEACHER_KEY

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = parse_qs(parsed.query)

        if path in ("/api/state", "/api/results") and not self._teacher_ok(qs):
            return self._send_json({"error": "teacher key required"}, 401)

        if path == "/api/ping":
            return self._send_json({"ok": True, "time": _now()})

        if path == "/api/state":
            with _lock:
                headsets = _prune_stale(STATE["headsets"])
            return self._send_json({"headsets": list(headsets.values())})

        if path == "/api/command":
            headset_id = (qs.get("headsetId") or [""])[0]
            group = (qs.get("group") or [""])[0]
            since = _int(qs, "since")
            with _lock:
                applicable = [
                    c for c in STATE["commands"]
                    if c["id"] > since and (
                        c["scope"] == "all"
                        or (c["scope"] == "group" and c["target"] == group)
                        or (c["scope"] == "headset" and c["target"] == headset_id)
                    )
                ]
            latest = applicable[-1] if applicable else None
            # Som cloud-relayet: `command` til ældre Players, `commands` (sidste
            # 15 min), så et andet lokales Start ikke skjuler et Stop.
            recent_from = _now() - 15 * 60
            commands = [c for c in applicable if c["ts"] >= recent_from][-50:]
            return self._send_json({"command": latest, "commands": commands})

        if path == "/api/results":
            since = _int(qs, "since")
            with _lock:
                _prune_results()
                results = [body for seq, _, body in STATE["results"] if seq > since]
                total = STATE["last_result_seq"]  # cursor: sendes tilbage som `since`
            return self._send_json({"results": results, "total": total})

        # Statiske filer: /player/... -> Player-mappen, ellers Dashboard.
        if path == "/player" or path.startswith("/player/"):
            return self._serve_static(PLAYER_DIR, path[len("/player"):] or "/")
        return self._serve_static(DASHBOARD_DIR, path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/command" and not self._teacher_ok(parse_qs(parsed.query)):
            return self._send_json({"error": "teacher key required"}, 401)
        body = self._read_json()
        if not isinstance(body, dict):
            body = {}

        if path == "/api/heartbeat":
            headset_id = str(body.get("headsetId") or "Unnamed headset")
            with _lock:
                # Nøgle inkl. enhed, så to lokalers "Headset 03" holdes adskilt.
                STATE["headsets"][_headset_key(body)] = {
                    "headsetId": headset_id,
                    "deviceId": body.get("deviceId", ""),
                    "origin": body.get("origin", ""),
                    "group": body.get("group", "Hold 1"),
                    "scenario": body.get("scenario", ""),
                    "nodeId": body.get("nodeId", ""),
                    "nodeTitle": body.get("nodeTitle", ""),
                    "status": body.get("status", "idle"),  # idle|waiting|running|done
                    "sessionTimeSec": body.get("sessionTimeSec", 0),
                    "answers": _clean_answers(body.get("answers")),
                    "lastSeen": _now(),
                }
            return self._send_json({"ok": True})

        if path == "/api/command":
            scope = body.get("scope", "all")
            target = body.get("target")
            action = body.get("action", "start")
            scenario = body.get("scenario", "")
            origin = body.get("origin", "")
            with _lock:
                cmd = {
                    "id": STATE["next_command_id"],
                    "scope": scope,
                    "target": target,
                    "action": action,
                    "scenario": scenario,
                    "origin": origin,
                    "ts": _now(),
                }
                STATE["next_command_id"] += 1
                STATE["commands"].append(cmd)
                # Begrænset, så listen ikke vokser for evigt.
                if len(STATE["commands"]) > 500:
                    STATE["commands"] = STATE["commands"][-500:]
            return self._send_json({"ok": True, "command": cmd})

        if path == "/api/results":
            if not isinstance(body.get("events"), list):
                return self._send_json({"error": "not a result"}, 400)
            with _lock:
                STATE["last_result_seq"] += 1
                idx = STATE["last_result_seq"]
                STATE["results"].append((idx, _now(), body))
                _prune_results()
            # Gem også straks en kopi på disk, så et nedbrud ikke mister resultatet.
            try:
                os.makedirs(RESULTS_DIR, exist_ok=True)
                safe = lambda s: "".join(c if c.isalnum() else "_" for c in str(s))[:80]
                fname = "%s_%s_%d.json" % (
                    safe(body.get("headsetId", "unknown")),
                    safe(body.get("deviceId", "")),
                    int(_now()),
                )
                with open(os.path.join(RESULTS_DIR, fname), "w", encoding="utf-8") as f:
                    json.dump(body, f, ensure_ascii=False, indent=2)
            except Exception as e:
                sys.stderr.write("Warning: could not persist result to disk: %s\n" % e)
            with _lock:
                # Et færdigt headset skal ikke længere stå som "running" på kortet.
                hid = _headset_key(body)
                if hid in STATE["headsets"]:
                    STATE["headsets"][hid]["status"] = "done"
                    STATE["headsets"][hid]["lastSeen"] = _now()
            return self._send_json({"ok": True, "index": idx})

        self.send_error(404, "Not found")


def _lan_ip():
    """Bedste bud på computerens IP på det lokale net, så adressen kan vises
    på skærmen."""
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # sender ingen pakker, vælger bare en rute
        return s.getsockname()[0]
    except Exception:
        return "localhost"
    finally:
        s.close()


def main():
    if not os.path.isdir(PLAYER_DIR):
        sys.stderr.write(
            "Warning: Player folder not found at %s\n"
            "  Headsets won't be able to load /player/ until this path exists.\n"
            % PLAYER_DIR
        )
    os.makedirs(RESULTS_DIR, exist_ok=True)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    ip = _lan_ip()

    print()
    print("=" * 64)
    print("  LærbarXR is running. Keep this window open during class.")
    print("=" * 64)
    print()
    print("  Your screen (Dashboard) is opening in your browser now.")
    print()
    print("  On EACH headset, open this address in its browser:")
    print()
    print("      http://%s:%d/player/" % (ip, PORT))
    print()
    print("  Everyone must be on the SAME Wi-Fi as this computer — and it")
    print("  must be a Wi-Fi you control (a travel router or a phone")
    print("  hotspot), not a school/office network. Those networks usually")
    print("  block devices from seeing each other on purpose, and headsets")
    print("  will just sit at 'Waiting for the instructor' forever if so.")
    print()
    print("  When class is done, just close this window.")
    print("=" * 64)
    print()
    sys.stdout.flush()

    # Åbn Dashboardet automatisk. Fejler det, bruges den viste URL i stedet.
    def _open_browser():
        time.sleep(0.6)
        try:
            import webbrowser
            webbrowser.open("http://localhost:%d/" % PORT)
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        httpd.shutdown()


if __name__ == "__main__":
    main()
