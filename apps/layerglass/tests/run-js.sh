#!/bin/sh
set -eu

# ESM resolves dependencies beside the importing file, without NODE_PATH.
# Keep npm dependencies and copied test sources in this one-off container.
task_js_dir=$(mktemp -d /tmp/layerglass-js.XXXXXX)
trap 'rm -rf "$task_js_dir"' EXIT
cp /app/package.json /app/package-lock.json "$task_js_dir/"
cp /app/nx.json /app/VERSION /app/README.md /app/AGENTS.md "$task_js_dir/"
cp /app/tsconfig*.json /app/.prettierrc.json /app/.prettierignore "$task_js_dir/"
cp -R /app/types "$task_js_dir/"
cp /app/eslint.config.ts "$task_js_dir/"
cp /app/.gitignore /app/.nxignore "$task_js_dir/"
cp -R /app/apps /app/infra /app/scripts /app/docs /app/tests /app/.agents /app/.github "$task_js_dir/"
cd "$task_js_dir"
# Worktree .git points outside the child container. Nx does not need Git to run
# explicit projects; ignore Git and never start a long-running background daemon.
export NX_DAEMON=false NX_NO_CLOUD=true NX_CACHE_DIRECTORY="$task_js_dir/.nx/cache"
npm ci --no-audit --no-fund --loglevel=error
node scripts/compile-browser.ts
if [ "$#" -eq 0 ]; then
  npm run typecheck
  npm run lint
  npm run format:check
  npm test
elif [ "$1" = "--workspace" ]; then
  npm run build
  npm run build
  npx nx show projects --json
  npx nx graph --file=/app/test-results/project-graph.json
  npm run check:docs
  LAYERGLASS_SITE_TEST_RESULTS="${LAYERGLASS_SITE_TEST_RESULTS:-/app/test-results}" npx nx test layerglass-site
else
  node --import tsx "$@"
fi
