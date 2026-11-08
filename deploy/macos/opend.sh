#!/usr/bin/env zsh
set -euo pipefail

# Control script for the OpenD service.
#
# TWO COPIES OF THIS FILE EXIST, deliberately. This one is committed, which is what gives it a
# history and what lets `~/recovery.sh` rebuild a lost machine. The other lives at ~/openD.sh and
# must keep working with NO repository cloned at all — that is the whole point of it, and it is
# why this is a copy rather than a symlink into here.
#
# They are kept honest by `make check-opend`, which fails when they differ — the same arrangement
# `check-ui` uses for the committed frontend bundle, because two copies of anything drift and the
# only question is whether you find out. `make opend-sync` copies this one over the other.
#
# The one difference by design: this copy has NO account number. ~/openD.sh keeps a literal
# default so it runs with nothing configured; here the account comes from OPEND_LOGIN_ACCOUNT,
# which `make launchd-opend-install` stamps into the generated launchd agent from .env. That is
# also why `check-opend` compares with the LOGIN_ACCOUNT line normalised away.
# Usage: ./openD.sh {start|stop|restart|status|health|ensure}

SCRIPT_DIR=${0:A:h}
# Overridable, because the committed copy of this script lives in a repository rather than beside
# _workspace: `${SCRIPT_DIR}/_workspace/OpenD` is right for ~/openD.sh and wrong for deploy/opend.sh.
OPEND_PATH=${OPEND_PATH:-${SCRIPT_DIR}/_workspace/OpenD}
OPEND_BIN=${OPEND_PATH}/OpenD.app/Contents/MacOS/OpenD
OPEND_CFG=${OPEND_PATH}/OpenD.xml
PID_FILE=${OPEND_PATH}/opend.pid
LOG_FILE=${OPEND_PATH}/opend.log

# Login. Since OpenD 10.10 the account/password are NOT in OpenD.xml: launching
# with no login flags drops into an *interactive* prompt. We pass the account
# explicitly and reuse the remembered credential stored (encrypted) under
# ~/.com.moomoo.OpenD/F3CNN/. Re-remember it by running the binary by hand:
#   $OPEND_BIN --cfg_files $OPEND_CFG
# Docs: https://openapi.moomoo.com/moomoo-api-doc/en/opend/opend-cmd.html
LOGIN_ACCOUNT=${OPEND_LOGIN_ACCOUNT:-}
LANG_CODE=${OPEND_LANG:-en}

# Where OpenD serves its API; read from the config so the two can't drift.
OPEND_IP=$(sed -n 's|.*<ip>\(.*\)</ip>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
OPEND_IP=${OPEND_IP:-127.0.0.1}
OPEND_PORT=$(sed -n 's|.*<api_port>\(.*\)</api_port>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
OPEND_PORT=${OPEND_PORT:-11111}

# Seconds to wait for the API port after launch.
STARTUP_TIMEOUT=${OPEND_STARTUP_TIMEOUT:-45}

# Telnet console, if enabled in OpenD.xml. The `[^!]*` guard keeps commented-out
# lines (`<!-- <telnet_port>...`) from matching.
TELNET_IP=$(sed -n 's|^[^!]*<telnet_ip>\(.*\)</telnet_ip>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
TELNET_PORT=$(sed -n 's|^[^!]*<telnet_port>\(.*\)</telnet_port>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
CONSOLE_WAIT=${OPEND_CONSOLE_WAIT:-8}       # fixed wait, nc fallback only
CONSOLE_DEADLINE=${OPEND_CONSOLE_DEADLINE:-25}  # `ping` polls every upstream server; it is not instant

running_pid() {
  # Prints the PID if OpenD is running, returns non-zero otherwise.
  #
  # Falls back to looking for the process itself, because the PID file only knows the instances
  # THIS script started. An OpenD launched from Finder is just as running, and without the
  # fallback the timer below would try to start a second one against ports already bound —
  # which is how a watchdog becomes the fault it was added to prevent.
  local pid
  if [[ -f $PID_FILE ]]; then
    pid=$(<"$PID_FILE")
    if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null; then
      print "$pid"
      return 0
    fi
  fi
  pid=$(pgrep -f 'OpenD.app/Contents/MacOS/OpenD' 2>/dev/null | head -1)
  if [[ -n $pid ]]; then
    print "$pid"
    return 0
  fi
  return 1
}

api_ready() {
  # True when OpenD's API port accepts a TCP connection, i.e. the gateway is
  # actually serving. Stronger than `kill -0`, which stays true even when OpenD
  # is sitting at a login prompt it will never get an answer to.
  if zmodload zsh/net/tcp 2>/dev/null && ztcp "$OPEND_IP" "$OPEND_PORT" 2>/dev/null; then
    ztcp -c "$REPLY" 2>/dev/null || true
    return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 1 "$OPEND_IP" "$OPEND_PORT" >/dev/null 2>&1 && return 0
  fi
  return 1
}

console_ping() {
  # Deep check: ask the telnet console to ping moomoo's servers. The reply is a
  # per-server Success/Failed table, which only comes back on an authenticated
  # session -- so this proves login, where an open API port alone does not.
  # Returns 0 = confirmed, 1 = no confirmation, 3 = console unavailable.
  [[ -n ${TELNET_PORT:-} ]] || return 3
  local ip=${TELNET_IP:-127.0.0.1}

  # Preferred: read until the server table appears or the deadline passes, so a
  # slow ping is not mistaken for a failed login.
  if command -v python3 >/dev/null 2>&1; then
    if python3 -c '
import re, socket, sys, time
ip = sys.argv[1]; port = int(sys.argv[2]); deadline = time.time() + float(sys.argv[3])
pat = re.compile("^Conn[0-9]+.*[0-9]+/[0-9]+", re.M)
s = None
while time.time() < deadline:          # console may not be listening yet at startup
    try:
        s = socket.create_connection((ip, port), timeout=5)
        break
    except OSError:
        time.sleep(1.0)
if s is None:
    sys.exit(1)
s.settimeout(1.0)
s.sendall(b"ping\r\n")
buf = ""
while time.time() < deadline:
    try:
        b = s.recv(65536)
        if not b:
            break
        buf += b.decode("utf-8", "replace")
        if pat.search(buf):
            s.close(); sys.exit(0)
    except socket.timeout:
        continue
    except OSError:
        break
s.close(); sys.exit(1)
' "$ip" "$TELNET_PORT" "$CONSOLE_DEADLINE"; then
      return 0
    fi
    return 1
  fi

  # Fallback: fixed-wait nc probe. Timing-sensitive; raise OPEND_CONSOLE_WAIT if
  # it reports false negatives.
  # DANGER: never send `exit` on this console -- it shuts OpenD down, it does not
  # just close the telnet session. Let nc hang up on its own instead.
  command -v nc >/dev/null 2>&1 || return 3
  local out
  out=$({ printf 'ping\r\n'; sleep "$CONSOLE_WAIT"; } \
        | nc -w $((CONSOLE_WAIT + 5)) "$ip" "$TELNET_PORT" 2>/dev/null) || true
  if print -r -- "$out" | grep -qE '^Conn[0-9]+.*[0-9]+/[0-9]+'; then
    return 0
  fi
  return 1
}

health() {
  # Full report: process, API port, upstream session.
  local pid rc=0
  if ! pid=$(running_pid); then
    print "OpenD is not running."
    return 1
  fi
  print "process   : running (pid $pid)"
  if api_ready; then
    print "api       : ${OPEND_IP}:${OPEND_PORT} accepting connections"
  else
    print -u2 "api       : ${OPEND_IP}:${OPEND_PORT} NOT accepting"
    return 2
  fi
  console_ping || rc=$?
  case $rc in
    0) print "upstream  : console ping OK -- session authenticated" ;;
    3) print "upstream  : not checked (telnet console disabled in OpenD.xml)" ;;
    *) print -u2 "upstream  : console ping returned no server table -- login is suspect"
       return 2 ;;
  esac
  return 0
}

start() {
  local pid i rc
  if [[ -z $LOGIN_ACCOUNT ]]; then
    print -u2 "Error: no account. Set OPEND_LOGIN_ACCOUNT, or run ~/openD.sh, which has one."
    return 1
  fi
  if pid=$(running_pid); then
    print "OpenD is already running (pid $pid)."
    return 0
  fi

  [[ -x $OPEND_BIN ]] || { print -u2 "Error: binary not found or not executable: $OPEND_BIN"; return 1; }
  [[ -f $OPEND_CFG ]] || { print -u2 "Error: config not found: $OPEND_CFG"; return 1; }

  print "Starting OpenD..."
  nohup "$OPEND_BIN" --cfg_files "$OPEND_CFG" \
    -login_account="$LOGIN_ACCOUNT" -login_by_remember=1 -lang="$LANG_CODE" \
    >>"$LOG_FILE" 2>&1 &
  pid=$!
  print "$pid" >"$PID_FILE"

  # Wait for the API port rather than just process liveness.
  for i in {1..$STARTUP_TIMEOUT}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      print -u2 "Error: OpenD exited during startup. Last log lines:"
      tail -n 20 "$LOG_FILE" >&2
      return 1
    fi
    if api_ready; then
      print "OpenD started (pid $pid), API on ${OPEND_IP}:${OPEND_PORT}. Logs: $LOG_FILE"
      rc=0; console_ping || rc=$?
      case $rc in
        0) print "Upstream session confirmed (console ping OK)." ;;
        3) : ;;  # console disabled; the API-port check above is all we have
        *) print -u2 "Warning: API is up but the console ping returned no server table."
           print -u2 "OpenD may be running unauthenticated -- check: tail -n 40 $LOG_FILE" ;;
      esac
      return 0
    fi
    sleep 1
  done

  print -u2 "Error: OpenD is alive (pid $pid) but ${OPEND_IP}:${OPEND_PORT} never opened within ${STARTUP_TIMEOUT}s."
  print -u2 "Most likely the remembered credential was rejected and it is waiting at a login prompt"
  print -u2 "with no terminal attached. Re-authenticate interactively, then retry:"
  print -u2 "  $OPEND_BIN --cfg_files $OPEND_CFG"
  print -u2 "Last log lines:"
  tail -n 20 "$LOG_FILE" >&2
  return 1
}

stop() {
  local pid
  if ! pid=$(running_pid); then
    print "OpenD is not running."
    return 0
  fi

  print "Stopping OpenD (pid $pid)..."
  kill "$pid"
  for _ in {1..10}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then
    print "OpenD did not exit gracefully, sending SIGKILL."
    kill -9 "$pid"
  fi
  rm -f "$PID_FILE"
  print "OpenD stopped."
}

ensure() {
  # What the launchd timer calls, once a minute. Idempotent and quiet when all is well, because a
  # watchdog that prints on every tick is a log nobody reads.
  #
  # Built on the primitives rather than on `health`'s exit code, because that code conflates two
  # failures that deserve opposite responses — and the first draft of this function therefore
  # refused to start a stopped OpenD, having matched its dying child process:
  #
  #   - no process            → start it.
  #   - process, but the API port is shut → a husk. RESTART, because `start` alone would try to
  #                             bind ports the husk may still hold.
  #   - API up, session not confirmed     → say so and STOP. Restarting might fix it, or might
  #                             need a human at the login window, and a restart a minute against
  #                             an expired credential is a watchdog flapping a provider — worse
  #                             than the dash it was trying to clear. The service's own
  #                             "monitoring degraded" reminder is what tells you, every half hour
  #                             until it recovers.
  #
  # The policy lives here rather than in the launchd plist, beside the checks that inform it.
  local stamp
  stamp=$(date '+%Y-%m-%d %H:%M:%S')

  if ! running_pid >/dev/null; then
    print "$stamp OpenD is not running; starting it."
    start
    return
  fi

  if ! api_ready; then
    print "$stamp OpenD is running but ${OPEND_IP}:${OPEND_PORT} is shut; restarting it."
    # stop-then-start, because `restart` is a case label in this script and not a function —
    # calling it here would have been a command that does not exist
    stop
    start
    return
  fi

  local rc=0
  console_ping || rc=$?
  case $rc in
    0|3) return 0 ;;   # confirmed, or the console is disabled and the port is all we have
    *)   print -u2 "$stamp OpenD is up but its session is not confirmed. Not restarting:"
         print -u2 "  that may need a human at the login window, and a restart a minute against"
         print -u2 "  an expired credential is worse than the dash it would clear."
         return 2 ;;
  esac
}

status() {
  local pid
  if pid=$(running_pid); then
    if api_ready; then
      print "OpenD is running (pid $pid); API ${OPEND_IP}:${OPEND_PORT} is accepting connections."
      return 0
    fi
    print -u2 "OpenD process is running (pid $pid) but ${OPEND_IP}:${OPEND_PORT} is NOT accepting."
    print -u2 "It is probably not logged in. See: tail -n 40 $LOG_FILE"
    return 2
  else
    print "OpenD is not running."
    return 1
  fi
}

case ${1:-} in
  start)         start ;;
  ensure)        ensure ;;
  stop|close)    stop ;;
  restart)       stop; start ;;
  status)        status ;;
  health|check)  health ;;
  *)             print -u2 "Usage: $0 {start|stop|restart|status|health|ensure}"; exit 1 ;;
esac
