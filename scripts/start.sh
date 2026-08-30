#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export DATABASE_URL="${DATABASE_URL:-postgres://mandate:mandate@127.0.0.1:5433/mandate_rescue}"
export RAZORPAY_MODE="${RAZORPAY_MODE:-test}"
export RAZORPAY_WEBHOOK_SECRET_TEST="${RAZORPAY_WEBHOOK_SECRET_TEST:-whsec_test_local}"
export DRY_RUN="${DRY_RUN:-true}"
export LOG_LEVEL="${LOG_LEVEL:-info}"
export PORT="${PORT:-3000}"

echo "→ database"
docker compose up -d >/dev/null 2>&1
for _ in $(seq 1 40); do
  docker compose exec -T db pg_isready -U mandate >/dev/null 2>&1 && break
  sleep 0.5
done
node packages/db/migrate.js

echo "→ dashboard build"
pnpm --filter @mandate/web build >/dev/null

echo "→ worker"
node apps/worker/src/index.ts &
WORKER=$!

cleanup() { kill "$WORKER" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

echo "→ api on http://localhost:${PORT}"
echo
echo "   landing    http://localhost:${PORT}/"
echo "   connect    http://localhost:${PORT}/onboard"
echo "   mandates   http://localhost:${PORT}/authorize"
echo "   dashboard  http://localhost:${PORT}/dashboard"
echo
if [ -n "${RAZORPAY_KEY_ID:-}" ]; then
  echo "   razorpay   ${RAZORPAY_KEY_ID}"
else
  echo "   razorpay   no key configured, live mandates are unavailable"
fi
echo
exec node apps/api/src/server.ts
