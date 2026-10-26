#!/usr/bin/env bash
set -euo pipefail

mode=${1:-all}
case "$mode" in python|javascript|workspace|unit|browser|all) ;; *) echo 'Usage: scripts/check.sh [python|javascript|workspace|unit|browser|all] [browser-suite.js ...]' >&2; exit 2 ;; esac
task_browser_suites=("${@:2}")
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
task_host_path=${LAYERGLASS_HOST_PATH:-$project_root}
task_run_id=${GITHUB_RUN_ID:-$$}
task_prefix="codex__layerglass_check__${task_run_id}"
task_image=${LAYERGLASS_TEST_IMAGE:-}
task_uid=$(id -u)
task_gid=$(id -g)
mkdir -p "$project_root/test-results/scrub-commit"
task_container_dir=$(mktemp -d /tmp/layerglass-check.XXXXXX)

container_id() {
  local task_id
  [[ -f "$1" ]] || return 1
  task_id=$(<"$1")
  [[ "$task_id" =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s\n' "$task_id"
}

cleanup() {
  task_status=$?
  if task_fixture_id=$(container_id "$task_container_dir/fixture.cid"); then
    docker logs "$task_fixture_id" > "$project_root/test-results/fixture.log" 2>&1 || true
  fi
  # Docker writes each private cidfile at creation, before foreground execution.
  # A rejected name has no ID; later containers reusing that name are not ours.
  for task_cidfile in "$task_container_dir"/*.cid; do
    if task_container=$(container_id "$task_cidfile"); then
      docker rm -f "$task_container" >/dev/null 2>&1 || true
    fi
  done
  rm -rf "$task_container_dir" || true
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "${LAYERGLASS_TEST_IMAGE:-}" && "$mode" != javascript && "$mode" != workspace ]]; then
  # Run the immutable result without creating a tag or deleting build cache.
  docker build --iidfile "$task_container_dir/image.iid" \
    --build-arg "VERSION=$(cat "$project_root/VERSION")" "$project_root"
  if [[ -f "$task_container_dir/image.iid" ]]; then
    task_image=$(<"$task_container_dir/image.iid")
  fi
  if [[ ! "$task_image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo 'Build did not record a valid image ID.' >&2
    exit 1
  fi
fi

# Playwright requires the browser binaries from its matching image release.
# JavaScript/workspace-only checks intentionally do not build the Python image.
# Read their package pin in a small bootstrap container instead.
task_metadata_image=$task_image
task_metadata_command=(python -B -c "import json; print(json.load(open('package.json'))['devDependencies']['playwright'])")
if [[ "$mode" == javascript || "$mode" == workspace ]]; then
  task_metadata_image=node:24-bookworm
  task_metadata_command=(node --input-type=commonjs -p "require('./package.json').devDependencies.playwright")
fi
task_playwright_version=$(docker run --rm --init --name "${task_prefix}_playwright_version" \
  --cidfile "$task_container_dir/playwright_version.cid" \
  --user "$task_uid:$task_gid" -e PYTHONDONTWRITEBYTECODE=1 \
  -v "$task_host_path:/app:ro" -w /app "$task_metadata_image" "${task_metadata_command[@]}")
if [[ ! "$task_playwright_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Pin playwright to an exact stable version in package.json.' >&2
  exit 1
fi
task_playwright_image="mcr.microsoft.com/playwright:v${task_playwright_version}-noble"

run_python() {
  docker run --rm --init --name "${task_prefix}_python" --user "$task_uid:$task_gid" \
    --cidfile "$task_container_dir/python.cid" \
    -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/apps/backend \
    -v "$task_host_path:/app:ro" -w /app/apps/backend \
    "$task_image" python -B -m unittest discover -s tests -p 'test_*.py' -v \
    2>&1 | tee "$project_root/test-results/python.log"
  docker run --rm --init --name "${task_prefix}_docs" --user "$task_uid:$task_gid" \
    --cidfile "$task_container_dir/docs.cid" \
    -e PYTHONDONTWRITEBYTECODE=1 -v "$task_host_path:/app:ro" -w /app \
    "$task_image" python -B scripts/check-docs.py
}

run_javascript() {
  docker run --rm --init --name "${task_prefix}_javascript" --user "$task_uid:$task_gid" \
    --cidfile "$task_container_dir/javascript.cid" \
    -e npm_config_cache=/tmp/npm-cache -v "$task_host_path:/app:ro" -w /app \
    "$task_playwright_image" sh apps/web/tests/run-js.sh \
    2>&1 | tee "$project_root/test-results/javascript.log"
}

run_workspace() {
  docker run --rm --init --name "${task_prefix}_workspace" --user "$task_uid:$task_gid" \
    --cidfile "$task_container_dir/workspace.cid" \
    -e npm_config_cache=/tmp/npm-cache -v "$task_host_path:/app:ro" \
    -v "$task_host_path/test-results:/app/test-results" -w /app \
    "$task_playwright_image" sh apps/web/tests/run-js.sh --workspace \
    2>&1 | tee "$project_root/test-results/workspace.log"
}

run_browsers() {
  task_fixture="${task_prefix}_fixture"
  docker run --detach --rm --init --name "$task_fixture" --user "$task_uid:$task_gid" \
    --cidfile "$task_container_dir/fixture.cid" \
    -e PYTHONDONTWRITEBYTECODE=1 -e FIXTURE_TELEMETRY=1 -e FIXTURE_DUAL_TELEMETRY=1 \
    -e VIEWER_ALLOWED_ORIGINS=http://localhost:8080 -e VIEWER_BACKEND_ORIGINS=http://127.0.0.1:8080 \
    -e PWA_CACHE_ENABLED=0 -v "$task_host_path:/app:ro" -w /app \
    "$task_image" python -B apps/backend/tests/fixture_server.py >/dev/null
  task_fixture=$(container_id "$task_container_dir/fixture.cid")
  task_ready=0
  for ((task_attempt=0; task_attempt<30; task_attempt++)); do
    if docker exec "$task_fixture" python -c \
      "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz',timeout=2).read()" \
      >/dev/null 2>&1; then
      task_ready=1
      break
    fi
    sleep 1
  done
  if [[ "$task_ready" != 1 ]]; then
    echo 'Generated-camera fixture failed to become ready.' >&2
    docker logs "$task_fixture" >&2
    return 1
  fi
  docker run --rm --init --name "${task_prefix}_browser" --user "$task_uid:$task_gid" \
    --cidfile "$task_container_dir/browser.cid" \
    --network "container:$task_fixture" --shm-size=512m \
    -e npm_config_cache=/tmp/npm-cache -e VIEWER_URL=http://127.0.0.1:8080 -e PWA_CACHE_ENABLED=0 \
    -v "$task_host_path:/app:ro" -v "$task_host_path/test-results:/app/test-results" -w /app \
    "$task_playwright_image" sh apps/web/tests/run-js.sh apps/web/tests/run-browser.js "${task_browser_suites[@]}" \
    2>&1 | tee "$project_root/test-results/browser.log"
}

if [[ "$mode" == python || "$mode" == unit || "$mode" == all ]]; then run_python; fi
if [[ "$mode" == javascript || "$mode" == unit || "$mode" == all ]]; then run_javascript; fi
if [[ "$mode" == workspace || "$mode" == all ]]; then run_workspace; fi
if [[ "$mode" == browser || "$mode" == all ]]; then
  run_browsers
fi
