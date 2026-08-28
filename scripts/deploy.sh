#!/usr/bin/env bash
set -euo pipefail

if [ ! -f .env.prod ]; then
  echo "Missing .env.prod. Copy .env.prod.example and fill it in." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.prod
set +a

: "${SITE_ADDRESS:?SITE_ADDRESS must be set}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}"
: "${DATABASE_URL:?DATABASE_URL must be set}"

if [ "${DRY_RUN:-true}" = "false" ]; then
  echo "DRY_RUN is false. This deployment can move real money."
  read -r -p "Type LIVE to continue: " confirm
  [ "$confirm" = "LIVE" ] || { echo "Aborted."; exit 1; }
fi

if [ "${RAZORPAY_MODE:-test}" = "live" ] && [[ "${RAZORPAY_KEY_ID:-}" != rzp_live* ]]; then
  echo "RAZORPAY_MODE is live but RAZORPAY_KEY_ID is not a live key." >&2
  exit 1
fi
if [ "${RAZORPAY_MODE:-test}" != "live" ] && [[ "${RAZORPAY_KEY_ID:-}" == rzp_live* ]]; then
  echo "A live key is set while RAZORPAY_MODE is not live." >&2
  exit 1
fi

echo "Deploying to ${SITE_ADDRESS} (mode ${RAZORPAY_MODE:-test}, dry_run ${DRY_RUN:-true})"
docker compose -f compose.prod.yml --env-file .env.prod build
docker compose -f compose.prod.yml --env-file .env.prod up -d

echo "Waiting for health..."
for _ in $(seq 1 60); do
  if docker compose -f compose.prod.yml --env-file .env.prod exec -T api \
      wget -qO- http://127.0.0.1:3000/health >/dev/null 2>&1; then
    echo "Healthy."
    docker compose -f compose.prod.yml --env-file .env.prod ps
    exit 0
  fi
  sleep 2
done

echo "Never became healthy. Logs:" >&2
docker compose -f compose.prod.yml --env-file .env.prod logs --tail 50 api >&2
exit 1
