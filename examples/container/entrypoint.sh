#!/bin/sh
set -eu

# dori-superagent container entrypoint: start the session runtime's server, then run
# the container's command. Sessions are hosted by the server, so they are reachable
# from any `docker exec -it` session. The image carries hc (built with HC=1) or herdr.

if command -v hc >/dev/null 2>&1; then
  hc server start >/dev/null
else
  # nohup keeps the herdr server alive past the exec below.
  nohup herdr server >/dev/null 2>&1 </dev/null &
fi

exec "$@"
