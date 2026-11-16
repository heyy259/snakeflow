#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"
if [ -x "$DIR/node/node" ]; then
  exec "$DIR/node/node" launcher/launcher.mjs "$@"
fi
exec node launcher/launcher.mjs "$@"
