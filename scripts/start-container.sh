#!/bin/sh
set -e

export DISPLAY=:99

# Kill any leftover google-chrome / chromium processes once on startup
pkill -TERM -f 'google-chrome|chromium' 2>/dev/null || true
sleep 1
pkill -KILL -f 'google-chrome|chromium' 2>/dev/null || true

# Clean up any stale Xvfb lock/socket from a previous container restart
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true
mkdir -p /tmp/.X11-unix 2>/dev/null || true

# Start virtual X11 screen for headed Google Chrome
Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp -ac >/dev/null 2>&1 &

# Wait up to 3s for Xvfb socket to be ready
i=0
while [ ! -S /tmp/.X11-unix/X99 ] && [ "$i" -lt 30 ]; do
  sleep 0.1
  i=$((i + 1))
done

exec node --require ./server-timeouts.cjs server.js
