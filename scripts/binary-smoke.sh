#!/usr/bin/env bash
# Smoke-test a standalone binary end to end against its own practice EHR.
#   scripts/binary-smoke.sh dist/smart-doctor-linux-x64
set -euo pipefail
BIN="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
WORK="$(mktemp -d)"; cd "$WORK"
PORT=${PORT:-4031}
cleanup() { kill "$MOCK" 2>/dev/null || true; rm -rf "$WORK"; }
trap cleanup EXIT

"$BIN" --version
"$BIN" mock --port "$PORT" --mode auto-approve --write-profiles --quiet > mock.log 2>&1 & MOCK=$!
for _ in $(seq 50); do grep -q "Saved demo profiles" mock.log 2>/dev/null && break; sleep 0.1; done

echo "== backend, private key";  "$BIN" check demo-backend --no-color | grep "Result:"
echo "== backend, client secret"; SMART_DOCTOR_DEMO_SECRET=demo-secret-value "$BIN" check demo-secret --no-color | grep "Result:"
echo "== backend, wrong kid (expect failure)"; "$BIN" check demo-backend --kid nope --no-color | grep -A1 "Most likely" || true
echo "== launch, loopback redirect"
SMART_DOCTOR_NO_BROWSER=1 "$BIN" check demo-launch --no-color > launch.out 2> launch.err & L=$!
for _ in $(seq 100); do URL=$(grep -o 'http://127.0.0.1:[0-9]*/oauth2/authorize?[^ ]*' launch.err || true); [ -n "$URL" ] && break; sleep 0.1; done
curl -s -L -o /dev/null "$URL"   # the "browser": auto-approve redirects to the loopback listener
wait $L; grep "Result:" launch.out
echo "== explain"; "$BIN" explain '{"error":"invalid_client","error_description":"jti already used"}' | sed -n 2p
echo "OK"
