#!/usr/bin/env bash
set -euo pipefail

ACTION="${1:-status}"
COMPOSE="docker compose -f compose.prod.yml --env-file .env.prod"

case "$ACTION" in
  on)
    $COMPOSE exec -T db psql -U "${POSTGRES_USER:-mandate}" -d "${POSTGRES_DB:-mandate_rescue}" \
      -c "UPDATE control_flags SET kill_switch = TRUE, kill_switch_reason = '${2:-manual}', updated_at = now() WHERE id = 1"
    echo "Kill switch ENGAGED. All execution halted."
    ;;
  off)
    $COMPOSE exec -T db psql -U "${POSTGRES_USER:-mandate}" -d "${POSTGRES_DB:-mandate_rescue}" \
      -c "UPDATE control_flags SET kill_switch = FALSE, kill_switch_reason = NULL, updated_at = now() WHERE id = 1"
    echo "Kill switch released."
    ;;
  status)
    $COMPOSE exec -T db psql -U "${POSTGRES_USER:-mandate}" -d "${POSTGRES_DB:-mandate_rescue}" \
      -c "SELECT kill_switch, kill_switch_reason, updated_at FROM control_flags WHERE id = 1"
    ;;
  *)
    echo "Usage: $0 {on [reason]|off|status}" >&2
    exit 1
    ;;
esac
