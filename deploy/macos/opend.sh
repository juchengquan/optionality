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
# `ensure`'s memory between ticks: since when ITS OpenD's API port has been shut ("<pid> <epoch>"),
# and the last thing it reported ("<what> <epoch>"), so a report is said once rather than every minute.
SHUT_FILE=${OPEND_PATH}/opend.shut-since
REPORT_FILE=${OPEND_PATH}/opend.reported

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

# The websocket, which is how the service reaches OpenD (MOOMOO_WS_PORT in its .env, 33333). Read
# with the `[^!]*` guard, because the stock OpenD.xml that an OpenD `update` writes has these lines
# commented out — and a commented line is a websocket that is OFF, which is the 2026-11-11 failure:
# the sweep timed out for an hour while OpenD logged "Login successful" and its API port was open.
WS_IP=$(sed -n 's|^[^!]*<websocket_ip>\(.*\)</websocket_ip>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
WS_IP=${WS_IP:-127.0.0.1}
WS_PORT=$(sed -n 's|^[^!]*<websocket_port>\(.*\)</websocket_port>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)

# How long `ensure` lets an OpenD THIS SCRIPT STARTED sit with its API port shut before restarting
# it. Not a minute: a shut port usually means OpenD is waiting at a login prompt, and a restart a
# minute is a watchdog flapping a provider. One it did not start is never restarted at all.
RESTART_AFTER=${OPEND_RESTART_AFTER:-900}
# How often `ensure` repeats a report while nothing changes. Once a minute is a log nobody reads.
REPORT_EVERY=${OPEND_REPORT_EVERY:-1800}

# Telnet console, if enabled in OpenD.xml. The `[^!]*` guard keeps commented-out
# lines (`<!-- <telnet_port>...`) from matching.
TELNET_IP=$(sed -n 's|^[^!]*<telnet_ip>\(.*\)</telnet_ip>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
TELNET_PORT=$(sed -n 's|^[^!]*<telnet_port>\(.*\)</telnet_port>.*|\1|p' "$OPEND_CFG" 2>/dev/null | head -1)
CONSOLE_WAIT=${OPEND_CONSOLE_WAIT:-8}       # fixed wait, nc fallback only
CONSOLE_DEADLINE=${OPEND_CONSOLE_DEADLINE:-25}  # `ping` polls every upstream server; it is not instant

all_pids() {
  # Every OpenD running, however it was started: by this script, from Finder, or by hand at a
  # terminal to log in. One pid a line; nothing when there is none.
  pgrep -f 'OpenD.app/Contents/MacOS/OpenD' 2>/dev/null || true
}

own_pid() {
  # The OpenD THIS SCRIPT started, if it is still running: the PID file's pid, and only while that
  # pid is still an OpenD — a pid is reused, and a stale file must never point `stop` at whatever
  # process inherited the number.
  local pid
  [[ -f $PID_FILE ]] || return 1
  pid=$(<"$PID_FILE")
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null || return 1
  all_pids | grep -qx -- "$pid" || return 1
  print "$pid"
}

running_pid() {
  # Prints the PID if OpenD is running, returns non-zero otherwise: its own first, else any.
  #
  # Falls back to looking for the process itself, because the PID file only knows the instances
  # THIS script started. An OpenD launched from Finder is just as running, and without the
  # fallback the timer below would try to start a second one against ports already bound —
  # which is how a watchdog becomes the fault it was added to prevent. Running is not the same as
  # OURS, though: `ensure` restarts only `own_pid`, never one this finds (2026-11-12, below).
  local pid
  if pid=$(own_pid); then
    print "$pid"
    return 0
  fi
  pid=$(all_pids | head -1)
  if [[ -n $pid ]]; then
    print "$pid"
    return 0
  fi
  return 1
}

port_open() {
  # True when something accepts a TCP connection on $1:$2.
  if zmodload zsh/net/tcp 2>/dev/null && ztcp "$1" "$2" 2>/dev/null; then
    ztcp -c "$REPLY" 2>/dev/null || true
    return 0
  fi
  if command -v nc >/dev/null 2>&1; then
    nc -z -w 1 "$1" "$2" >/dev/null 2>&1 && return 0
  fi
  return 1
}

api_ready() {
  # True when OpenD's API port accepts a TCP connection, i.e. the gateway is
  # actually serving. Stronger than `kill -0`, which stays true even when OpenD
  # is sitting at a login prompt it will never get an answer to.
  port_open "$OPEND_IP" "$OPEND_PORT"
}

ws_ready() {
  # The websocket the service actually uses. False when OpenD.xml does not enable it at all.
  [[ -n ${WS_PORT:-} ]] && port_open "$WS_IP" "$WS_PORT"
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
  if [[ -z ${WS_PORT:-} ]]; then
    print -u2 "websocket : OFF in $OPEND_CFG -- the service cannot reach OpenD"
    return 2
  elif ws_ready; then
    print "websocket : ${WS_IP}:${WS_PORT} accepting connections"
  else
    print -u2 "websocket : ${WS_IP}:${WS_PORT} NOT accepting"
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

terminate() {
  # Stop each pid given: SIGTERM, ten seconds' grace, then SIGKILL.
  local pid alive
  for pid in "$@"; do
    print "Stopping OpenD (pid $pid)..."
    kill "$pid" 2>/dev/null || true
  done
  for _ in {1..10}; do
    alive=0
    for pid in "$@"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    (( alive )) || break
    sleep 1
  done
  for pid in "$@"; do
    if kill -0 "$pid" 2>/dev/null; then
      print "OpenD (pid $pid) did not exit gracefully, sending SIGKILL."
      kill -9 "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PID_FILE" "$SHUT_FILE"
}

stop() {
  # EVERY OpenD, not only this script's: run by hand, `stop` means "no OpenD", and stopping one of
  # two left the other holding the ports (2026-11-12). `ensure` never calls this.
  local -a pids
  pids=(${(f)"$(all_pids)"})
  if (( ${#pids} == 0 )); then
    rm -f "$PID_FILE" "$SHUT_FILE"
    print "OpenD is not running."
    return 0
  fi
  terminate "${pids[@]}"
  print "OpenD stopped."
}

report() {
  # A report from `ensure`, to stderr: said when it first applies, then at most every REPORT_EVERY
  # seconds while it still does. $1 names the state; the rest are its lines.
  local what=$1 now last_what="" last_at=0
  shift
  now=$(date +%s)
  if [[ -f $REPORT_FILE ]]; then
    read -r last_what last_at <"$REPORT_FILE" || true
  fi
  if [[ $last_what == "$what" ]] && (( now - ${last_at:-0} < REPORT_EVERY )); then
    return 0
  fi
  print "$what $now" >"$REPORT_FILE"
  print -u2 -l -- "$@"
}

shut_for() {
  # Seconds pid $1's API port has been shut, counted from the first tick that saw it shut.
  local pid=$1 now was="" since=""
  now=$(date +%s)
  if [[ -f $SHUT_FILE ]]; then
    read -r was since <"$SHUT_FILE" || true
  fi
  if [[ $was != "$pid" || -z $since ]]; then
    since=$now
    print "$pid $since" >"$SHUT_FILE"
  fi
  print $(( now - since ))
}

ensure() {
  # What the launchd timer calls, once a minute. Idempotent and quiet when all is well, because a
  # watchdog that prints on every tick is a log nobody reads — and a report is said once, then every
  # REPORT_EVERY seconds while it stands.
  #
  # Built on the primitives rather than on `health`'s exit code, because that code conflates
  # failures that deserve opposite responses:
  #
  #   - no process                        → start it.
  #   - process, but the API port is shut → REPORT, almost always. A shut port usually means OpenD
  #                             is waiting at a login prompt, and the first version of this read
  #                             it as a husk and restarted it every minute. On 2026-11-12 (12:19–
  #                             12:33) the owner started a second OpenD by hand to log in; the
  #                             watchdog stopped one, found the owner's "already running", and two
  #                             minutes later killed the owner's at its login window. So:
  #                               · one this script did NOT start (no PID file: Finder, a terminal)
  #                                 is never stopped, however long its port stays shut;
  #                               · neither is anything while such a one is running beside its own;
  #                               · its OWN, alone, is restarted only once the port has been shut
  #                                 for RESTART_AFTER seconds (15 minutes) — a husk that will not
  #                                 recover, rather than a login that has not happened yet.
  #   - API up, websocket shut or OFF     → REPORT. The service talks to OpenD over the websocket,
  #                             so this is dashes with a healthy-looking OpenD; it is a config
  #                             fault (an OpenD `update` rewrites OpenD.xml), not a restartable one.
  #   - API up, session not confirmed     → REPORT. Restarting might fix it, or might need a human
  #                             at the login window, and a restart a minute against an expired
  #                             credential is a watchdog flapping a provider — worse than the dash
  #                             it was trying to clear. The service's own "monitoring degraded"
  #                             reminder is what tells you, every half hour until it recovers.
  #
  # The policy lives here rather than in the launchd plist, beside the checks that inform it.
  local stamp pid own="" others shut
  stamp=$(date '+%Y-%m-%d %H:%M:%S')

  if ! pid=$(running_pid); then
    rm -f "$PID_FILE" "$SHUT_FILE" "$REPORT_FILE"
    print "$stamp OpenD is not running; starting it."
    start
    return
  fi

  if ! api_ready; then
    own=$(own_pid) || own=""
    others=$(all_pids | grep -vx -- "${own:-none}" || true)
    if [[ -z $own ]]; then
      rm -f "$SHUT_FILE"
      report "foreign-shut" \
        "$stamp OpenD (pid $pid) is running but ${OPEND_IP}:${OPEND_PORT} is shut. Not restarting it:" \
        "  it was not started by this script (by hand, or from Finder), so it may be at its login" \
        "  window. Log in there, or run \`$0 stop\` to let this watchdog start its own."
      return 2
    fi
    if [[ -n $others ]]; then
      report "beside-shut" \
        "$stamp ${OPEND_IP}:${OPEND_PORT} is shut, and an OpenD this script did not start is running" \
        "  beside its own (pid $own): pids ${(f)others}. Not restarting either -- someone is logging in."
      return 2
    fi
    shut=$(shut_for "$own")
    if (( shut >= RESTART_AFTER )); then
      print "$stamp OpenD (pid $own, started by this script) has had ${OPEND_IP}:${OPEND_PORT} shut for ${shut}s; restarting it."
      terminate "$own"
      rm -f "$REPORT_FILE"
      start
      return
    fi
    report "own-shut" \
      "$stamp OpenD (pid $own) is running but ${OPEND_IP}:${OPEND_PORT} is shut -- most likely at a login" \
      "  prompt. Not restarting yet: this script restarts its own only after ${RESTART_AFTER}s shut." \
      "  Log in by hand: $OPEND_BIN --cfg_files $OPEND_CFG"
    return 2
  fi
  rm -f "$SHUT_FILE"

  if [[ -z ${WS_PORT:-} ]]; then
    report "ws-off" \
      "$stamp OpenD is up but its websocket is OFF in $OPEND_CFG (<websocket_port> missing or" \
      "  commented out) -- and the service reaches OpenD only over it. An OpenD \`update\` writes the" \
      "  stock OpenD.xml: restore <websocket_port> and the key's MD5, then restart OpenD."
    return 2
  fi
  if ! ws_ready; then
    report "ws-shut" \
      "$stamp OpenD is up on ${OPEND_IP}:${OPEND_PORT} but its websocket ${WS_IP}:${WS_PORT} is shut --" \
      "  the service reaches OpenD only over it. Not restarting: check OpenD.xml and OpenD's log."
    return 2
  fi

  local rc=0
  console_ping || rc=$?
  case $rc in
    0|3) rm -f "$REPORT_FILE"; return 0 ;;   # confirmed, or the console is disabled and the ports are all we have
    *)   report "unconfirmed" \
           "$stamp OpenD is up but its session is not confirmed. Not restarting:" \
           "  that may need a human at the login window, and a restart a minute against" \
           "  an expired credential is worse than the dash it would clear."
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
