#!/bin/sh
# Stand-in for /usr/bin/open, passed to the current update helper through its
# MOSA_UPDATE_OPEN_BIN rehearsal override. The helper calls
#   open -n <App.app> [--args <app args...>]
# and this hands the same app and arguments to launch-isolated.sh.
set -eu
[ "$1" = "-n" ] || { echo "open-standin: expected -n, got $1" >&2; exit 64; }
APP="$2"
shift 2
if [ "$#" -gt 0 ] && [ "$1" = "--args" ]; then shift; fi
exec "$(dirname "$0")/launch-isolated.sh" "$APP" "$@"
