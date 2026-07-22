#!/bin/bash
# Usage: ./tail.sh <ssh-target> <remote-log-path>
# Example: ./tail.sh user@server /var/log/app.log
#
# Streams remote log to local file, auto-reconnects on disconnect.

set -euo pipefail

SSH_TARGET="${1:?Usage: ./tail.sh <ssh-target> <remote-log-path>}"
REMOTE_LOG="${2:?Usage: ./tail.sh <ssh-target> <remote-log-path>}"

LOG_DIR="$(dirname "$0")/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/stream.jsonl"

echo "Tailing $SSH_TARGET:$REMOTE_LOG → $LOG_FILE"
echo "Auto-reconnect on disconnect. Press Ctrl+C to stop."

while true; do
  ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=3 "$SSH_TARGET" "tail -F '$REMOTE_LOG'" >> "$LOG_FILE" 2>/dev/null
  echo ""
  echo "[$(date)] SSH disconnected. Reconnecting in 3s..."
  sleep 3
done