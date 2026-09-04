#!/usr/bin/env bash
set -euo pipefail

# Each package gets its own test database. They run in parallel, and the success
# model reads across merchants, so shared rows make a batch look unreproducible.
DATABASES=(mandate_rescue_test mandate_rescue_test_api)

for name in "${DATABASES[@]}"; do
  exists=$(docker compose exec -T db psql -U mandate -d postgres -tAc \
    "SELECT 1 FROM pg_database WHERE datname='${name}'")
  if [ "${exists}" != "1" ]; then
    docker compose exec -T db psql -U mandate -d postgres \
      -c "CREATE DATABASE ${name} OWNER mandate"
  fi
  DATABASE_URL="postgres://mandate:mandate@127.0.0.1:5433/${name}" node packages/db/migrate.js
done
