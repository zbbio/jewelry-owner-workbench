#!/bin/sh
set -eu
test "$(uname -s)" = Linux || { printf '%s\n' 'LINUX_REQUIRED' >&2; exit 2; }
: "${N15_CONFIG:?absolute-private-operator-config-required}"
case "$N15_CONFIG" in /*) ;; *) printf '%s\n' 'CONFIG_ABSOLUTE_PATH_REQUIRED' >&2; exit 2;; esac
base=$(CDPATH='' cd -- "$(dirname -- "$0")/../backend" && pwd)
umask 077
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if (major<22 || major===22 && minor<13) { console.error("PINNED_NODE_22_13_PLUS_REQUIRED"); process.exit(2); }'
node "$base/ops.mjs" selfcheck
exec node "$base/serve.mjs"
