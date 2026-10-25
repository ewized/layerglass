#!/usr/bin/env bash
set -euo pipefail

mode=${1:-all}
case "$mode" in python|javascript|workspace|unit|browser|all) ;; *) echo 'Usage: scripts/check.sh [python|javascript|workspace|unit|browser|all] [browser-suite.js ...]' >&2; exit 2 ;; esac
task_browser_suites=("${@:2}")
project_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
task_host_path=${LAYERGLASS_HOST_PATH:-$project_root}
task_run_id=${GITHUB_RUN_ID:-$$}
task_prefix="codex__layerglass_check__${task_run_id}"
task_image=${LAYERGLASS_TEST_IMAGE:-local/layerglass-check:$task_run_id}
task_playwright_image=mcr.microsoft.com/playwright:v1.61.1-noble
task_uid=$(id -u)
task_gid=$(id -g)
task_image_owned=0
task_containers=()
mkdir -p "$project_root/test-results/scrub-commit"

cleanup() {
  task_status=$?
  if [[ -n "${task_fixture:-}" ]]; then
    docker logs "$task_fixture" > "$project_root/test-results/fixture.log" 2>&1 || true
  fi
  for task_container in "${task_containers[@]}"; do
    docker rm -f "$task_container" >/dev/null 2>&1 || true
  done
  if [[ "$task_image_owned" == 1 ]]; then
    docker image rm "$task_image" >/dev/null 2>&1 || true
  fi
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ -z "${LAYERGLASS_TEST_IMAGE:-}" && "$mode" != javascript && "$mode" != workspace ]]; then
  task_image_owned=1
  docker build --tag "$task_image" --build-arg "VERSION=$(cat "$project_root/VERSION")" "$project_root"
fi

run_python() {
  task_containers+=("${task_prefix}_python")
  docker run --rm --init --name "${task_prefix}_python" --user "$task_uid:$task_gid" \
    -e PYTHONDONTWRITEBYTECODE=1 -e PYTHONPATH=/app/apps/backend \
    -v "$task_host_path:/app:ro" -w /app/apps/backend \
    "$task_image" python -B -m unittest discover -s tests -p 'test_*.py' -v \
    2>&1 | tee "$project_root/test-results/python.log"
  task_containers+=("${task_prefix}_docs")
  docker run --rm --init --name "${task_prefix}_docs" --user "$task_uid:$task_gid" \
    -e PYTHONDONTWRITEBYTECODE=1 -v "$task_host_path:/app:ro" -w /app \
    "$task_image" python -B scripts/check-docs.py
}

run_javascript() {
  task_containers+=("${task_prefix}_javascript")
  docker run --rm --init --name "${task_prefix}_javascript" --user "$task_uid:$task_gid" \
    -e npm_config_cache=/tmp/npm-cache -v "$task_host_path:/app:ro" -w /app \
    "$task_playwright_image" sh apps/web/tests/run-js.sh \
    2>&1 | tee "$project_root/test-results/javascript.log"
}

run_workspace() {
  task_containers+=("${task_prefix}_workspace")
  docker run --rm --init --name "${task_prefix}_workspace" --user "$task_uid:$task_gid" \
    -e npm_config_cache=/tmp/npm-cache -v "$task_host_path:/app:ro" \
    -v "$task_host_path/test-results:/app/test-results" -w /app \
    "$task_playwright_image" sh apps/web/tests/run-js.sh --workspace \
    2>&1 | tee "$project_root/test-results/workspace.log"
}

run_browsers() {
  task_fixture="${task_prefix}_fixture"
  task_containers+=("$task_fixture")
  docker run --detach --rm --init --name "$task_fixture" --user "$task_uid:$task_gid" \
    -e PYTHONDONTWRITEBYTECODE=1 -e FIXTURE_TELEMETRY=1 -e FIXTURE_DUAL_TELEMETRY=1 \
    -e VIEWER_ALLOWED_ORIGINS=http://localhost:8080 -e VIEWER_BACKEND_ORIGINS=http://127.0.0.1:8080 \
    -e PWA_CACHE_ENABLED=0 -v "$task_host_path:/app:ro" -w /app \
    "$task_image" python -B apps/backend/tests/fixture_server.py >/dev/null
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
  task_containers+=("${task_prefix}_browser")
  docker run --rm --init --name "${task_prefix}_browser" --user "$task_uid:$task_gid" \
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
