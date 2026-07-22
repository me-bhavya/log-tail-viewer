#!/bin/bash
# Generates sample logs with long multi-line messages for testing.
# Usage: ./sample-logs.sh

set -euo pipefail

LOG_DIR="$(dirname "$0")/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/stream.jsonl"

echo "Writing sample logs (with long messages) to $LOG_FILE (Ctrl+C to stop)"

LEVELS=("DEBUG" "INFO" "WARN " "ERROR" "TRACE")
THREADS=("main" "worker-1" "worker-2" "scheduler" "http-nio-1")
LOGGERS=("c.m.s.UserService" "c.m.s.PaymentService" "c.m.a.AuthController" "c.m.w.RequestFilter")

declare -a MESSAGES=(
  "Processing user request for id=12345 — checking permissions, validating token, fetching user profile from cache, building response DTO, serializing to JSON, writing to output stream"
  "Failed to parse request body — invalid JSON at line 5 column 12: expected ':' but found ',' — original payload was: {\"userId\": 123, \"action\": \"transfer\", \"amount\": 500, \"currency\": \"USD\", \"source\": \"wallet-1\", \"destination\": \"wallet-2\", \"memo\": \"monthly settlement payment for Q4 2024\"}"
  "Database connection acquired from pool (active=3, idle=7, max=10) — executing query: SELECT u.id, u.name, u.email, u.created_at, u.last_login, p.balance, p.currency FROM users u JOIN wallets p ON p.user_id = u.id WHERE u.status = 'ACTIVE' AND p.balance > 1000 ORDER BY u.created_at DESC LIMIT 50"
  "Timeout calling upstream service after 5000ms — retrying with exponential backoff (attempt=2, max=3, base_delay=200ms, max_delay=2000ms) — target: http://internal-payments-svc:8080/v2/transfer — error: java.net.SocketTimeoutException: read timed out"
  "Background job completed — job=cleanup-expired-sessions — stats: { checked=1254, deleted=87, skipped=1167, errors=0, duration_ms=342, avg_per_item=0.27ms, thread=worker-2, scheduled_at=2024-01-15T10:30:00Z, completed_at=2024-01-15T10:30:00.342Z }"
)

while true; do
  LEVEL=${LEVELS[$((RANDOM % ${#LEVELS[@]}))]}
  THREAD=${THREADS[$((RANDOM % ${#THREADS[@]}))]}
  LOGGER=${LOGGERS[$((RANDOM % ${#LOGGERS[@]}))]}
  MSG=${MESSAGES[$((RANDOM % ${#MESSAGES[@]}))]}
  TS=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
  TRACE_ID=$(printf "t-%08x" $RANDOM$RANDOM)

  echo "$LEVEL [$TS] $TRACE_ID [$THREAD] [$LOGGER]: $MSG" >> "$LOG_FILE"

  sleep $(echo "scale=3; $RANDOM / 30000" | bc)
done