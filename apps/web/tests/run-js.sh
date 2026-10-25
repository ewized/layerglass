#!/bin/sh
set -eu

# ESM resolves dependencies beside the importing file, without NODE_PATH.
# Keep npm dependencies and copied test sources in this one-off container.
task_js_dir=$(mktemp -d /tmp/printer-camera-js.XXXXXX)
trap 'rm -rf "$task_js_dir"' EXIT
cp /app/package.json /app/package-lock.json "$task_js_dir/"
cp -R /app/static /app/tests "$task_js_dir/"
cd "$task_js_dir"
npm ci --no-audit --no-fund --loglevel=error
if [ "$#" -eq 0 ]; then
  npm test
else
  node "$@"
fi
