#!/bin/sh
# Starts a packaged MOSA.app / GravityPort.app fully isolated from the real
# install: its own user data, library and port. The rehearsal swaps the update
# helper's `/usr/bin/open -n "$INSTALL_APP"` lines for this script, because
# `open` would start the app with the real ~/Library/Application Support/mosa
# and ~/MOSA Library. App arguments go first: the current helper finds the new
# process by "<exe> --mosa-update-ready-file=".
#
# Usage: REHEARSAL_ROOT=<dir> launch-isolated.sh <path/to/App.app> [app args...]
set -eu
APP="$1"
shift
ROOT="${REHEARSAL_ROOT:?REHEARSAL_ROOT is required}"
PORT="${REHEARSAL_PORT:-43617}"
NAME=$(basename "$APP" .app)
mkdir -p "$ROOT/user-data" "$ROOT/library" "$ROOT/logs"
# Task 346: give every isolated launch its own packaged quiet token and write
# the marker the packaged quiet gate (desktop/quiet-qa-screen.mjs) reads, so
# rehearsal launches run silent like the packaged smoke. The token never goes
# to the log; the switch is appended after the app arguments so the update
# helper still finds the new process by "<exe> --mosa-update-ready-file=".
QA_QUIET_TOKEN=$(openssl rand -hex 16 2>/dev/null || od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
printf '{"token":"%s"}\n' "$QA_QUIET_TOKEN" > "$ROOT/user-data/gravityport-qa-quiet.json"
echo "$(date '+%H:%M:%S') launch $APP $*" >> "$ROOT/logs/launches.log"
MOSA_RUNTIME_MODE=qa MOSA_QA_RUN=1 \
  MOSA_USER_DATA="$ROOT/user-data" MOSA_LIBRARY_DIR="$ROOT/library" \
  MOSA_DESKTOP_PORT="$PORT" MOSA_DISABLE_TELEMETRY=1 \
  nohup "$APP/Contents/MacOS/$NAME" "$@" "--gravityport-qa-quiet=$QA_QUIET_TOKEN" "--user-data-dir=$ROOT/user-data" \
  >> "$ROOT/logs/$NAME.log" 2>&1 &
