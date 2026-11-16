#!/bin/sh
# Stands in for an agent on hc: no model call, it reports its status the way hc reads it (OSC 7501) and echoes input.
# Record: ESC ] 7501 ; state=<word>:app=<app> ESC \  (fields joined by ':'). Idle at start; working for 2 s after each
# line it reads (the line is echoed), then idle again. Arguments (a kickoff prompt) are echoed once.
set -u
report() { printf '\033]7501;state=%s:app=fake\033\\' "$1"; }
[ "$#" -gt 0 ] && printf 'kickoff: %s\n' "$*"
report idle
while IFS= read -r line; do
  report working
  printf 'echo: %s\n' "$line"
  sleep 2
  report idle
done
