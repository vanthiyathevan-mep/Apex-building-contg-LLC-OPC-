#!/bin/sh
# Make sure the data directory is writable by the app user (hosted disks are often
# mounted root-owned), then run the app as the unprivileged "node" user.
set -e
DATA_DIR="$(dirname "${ERP_DB_FILE:-/data/erp.db}")"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  chown node:node "$DATA_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
