#!/usr/bin/env bash
# Kører browsertestene. Kræver Builder, Player og Dashboard klonet side om side,
# Node 18+ og Playwright (`npm i -g playwright`, `npx playwright install chromium`,
# eller sæt CHROMIUM til en Chromium).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
STATE="$(mktemp -d)"
# wrangler starter workerd som underproces; dræbes kun wrapperen, bliver en
# relay med testdata hængende på :8787 til næste kørsel.
cleanup() { kill $HTTP_PID $RELAY_PID 2>/dev/null; pkill -f "$(cd "$HERE/../cloud-relay" && pwd)/node_modules" 2>/dev/null; rm -rf "$STATE"; }
trap cleanup EXIT

if curl -s -m 2 http://127.0.0.1:8787/api/ping >/dev/null; then echo "Something is already serving :8787 (a relay left over from an earlier run?) — stop it first." >&2; exit 1; fi
(cd "$ROOT" && exec python3 -m http.server 8765 >/dev/null 2>&1) & HTTP_PID=$!
(cd "$HERE/../cloud-relay" && npm install --silent --no-audit --no-fund >/dev/null 2>&1 &&
  exec npx wrangler dev --port 8787 --persist-to "$STATE" --var TEACHER_KEY:k-test-1 >"$STATE/relay.log" 2>&1) & RELAY_PID=$!
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:8787/api/ping >/dev/null && break; sleep 1; done

status=0
echo "== UI (Builder, Player, Dashboard)"; node "$HERE/ui.js" || status=1
echo "== Relay end-to-end (Dashboard + Player + local relay)"; node "$HERE/relay-e2e.js" || status=1
echo "== New features (multi-select, replay, Afslut, inactivity, live stats)"; node "$HERE/features.js" || status=1
exit $status
