#!/bin/bash
# Local macOS helper. Run from any working directory.
set -euo pipefail
umask 077

root="$(cd "$(dirname "$0")/.." && pwd)"
setup="$root/local-setup"
binary="$root/cli-proxy-api"
config="$root/config.yaml"
credentials="$setup/credentials.json"
base_url='http://127.0.0.1:8317/v1'
cd "$root"

fail() { echo "$*" >&2; exit 1; }
require() { command -v "$1" >/dev/null || fail "Install $1 first (see local-setup/README.md)."; }
listeners() { /usr/sbin/lsof -nP -tiTCP:8317 -sTCP:LISTEN 2>/dev/null || true; }
proxy_pids() {
    local pid
    for pid in $(listeners); do
        if /usr/sbin/lsof -a -p "$pid" -d txt -Fn 2>/dev/null | /usr/bin/grep -Fxq "n$binary"; then
            echo "$pid"
        fi
    done
}
load_credentials() {
    require jq
    [[ -f "$credentials" ]] || fail 'Run ./local-setup/proxy.sh init first.'
    [[ "$(jq -r '.base_url' "$credentials")" == "$base_url" ]] || fail "This helper requires $base_url."
    api_key="$(jq -er '.api_key | select(type == "string" and length > 0)' "$credentials")"
    [[ "$api_key" != REPLACE_WITH_* && "$api_key" != *$'\n'* && "$api_key" != *$'\r'* ]] || fail 'Set a valid private API key.'
}
api() {
    # Read the authorization header from stdin, keeping the key out of argv.
    printf 'Authorization: Bearer %s\n' "$api_key" |
        curl --noproxy '*' --silent --show-error --fail --header @- "$@"
}

action="$(printf '%s' "${1:-status}" | tr '[:upper:]' '[:lower:]')"
case "$action" in
    init)
        require jq
        [[ ! -e "$config" && ! -e "$credentials" ]] || fail 'Configuration already exists; existing files were preserved.'
        api_key="$(openssl rand -hex 32)"
        management_key="$(openssl rand -hex 32)"
        sed -e "s/REPLACE_WITH_YOUR_LOCAL_API_KEY/$api_key/" \
            -e "s/REPLACE_WITH_YOUR_LOCAL_MANAGEMENT_KEY/$management_key/" \
            "$setup/config.example.yaml" > "$config"
        # Only generated random hex values are inserted into JSON.
        printf '{\n  "base_url": "%s",\n  "api_key": "%s",\n  "management_key": "%s"\n}\n' \
            "$base_url" "$api_key" "$management_key" > "$credentials"
        mkdir -p "$root/auths" "$root/logs"
        chmod 600 "$config" "$credentials"
        chmod 700 "$root/auths" "$root/logs"
        echo 'Created private local configuration and credentials.'
        ;;
    build)
        require go
        [[ -z "$(proxy_pids)" ]] || fail 'Stop the proxy before rebuilding.'
        go build -o "$binary" ./cmd/server
        echo "Built $binary"
        ;;
    start)
        load_credentials
        require python3
        [[ -x "$binary" && -f "$config" ]] || fail 'Run init and build first.'
        if [[ -n "$(proxy_pids)" ]]; then
            api --connect-timeout 2 --max-time 5 "$base_url/models" >/dev/null
            echo "Proxy is already running at $base_url."
            exit 0
        fi
        [[ -z "$(listeners)" ]] || fail 'Port 8317 is occupied by another process.'
        # Each run preserves its logs; no fixed log path is overwritten.
        run_dir="$(mktemp -d "$setup/run-XXXXXXXX")"
        # A separate session survives the terminal or task that starts it.
        pid="$(python3 - "$binary" "$config" "$run_dir/server.log" <<'PY'
import subprocess
import sys

with open(sys.argv[3], "ab") as log:
    process = subprocess.Popen(
        [sys.argv[1], "--config", sys.argv[2]],
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
print(process.pid)
PY
)"
        for ((attempt=0; attempt<40; attempt++)); do
            kill -0 "$pid" 2>/dev/null || fail "Proxy exited; inspect $run_dir/server.log"
            if api --connect-timeout 1 --max-time 2 "$base_url/models" >/dev/null 2>&1; then
                echo "Proxy running at $base_url (PID $pid)."
                echo "Server log: $run_dir/server.log"
                exit 0
            fi
            sleep 0.25
        done
        fail "Proxy is not ready yet; inspect $run_dir/server.log"
        ;;
    stop)
        pids="$(proxy_pids)"
        [[ -n "$pids" ]] || { echo 'Proxy is already stopped.'; exit 0; }
        for pid in $pids; do kill -TERM "$pid"; done
        for ((attempt=0; attempt<40; attempt++)); do
            [[ -n "$(proxy_pids)" ]] || { echo 'Proxy stopped.'; exit 0; }
            sleep 0.25
        done
        fail 'Proxy is still shutting down; check status before rebuilding.'
        ;;
    status)
        load_credentials
        models="$(api --connect-timeout 2 --max-time 5 "$base_url/models")"
        echo "Proxy is reachable at $base_url."
        printf '%s' "$models" | jq -r '"Available models: \(.data | length)", .data[].id'
        ;;
    login|devicelogin)
        [[ -x "$binary" && -f "$config" ]] || fail 'Run init and build first.'
        flag=--codex-login
        [[ "$action" != devicelogin ]] || flag=--codex-device-login
        exec "$binary" --config "$config" "$flag"
        ;;
    test)
        load_credentials
        model="${2:-gpt-5.4-mini}"
        models="$(api --connect-timeout 2 --max-time 5 "$base_url/models")"
        printf '%s' "$models" | jq -e --arg model "$model" 'any(.data[]; .id == $model)' >/dev/null ||
            fail "Model $model is unavailable. Complete login, then use status to list models."
        body="$(jq -nc --arg model "$model" '{model: $model, input: "Reply with exactly: proxy-ok", stream: false}')"
        response="$(api "$base_url/responses" -H 'Content-Type: application/json' --data-binary "$body")"
        printf '%s' "$response" | jq -er 'select(.status == "completed") | [.output[]?.content[]? | select(.type == "output_text") | .text] | join("\n") | select(length > 0)'
        ;;
    *) fail 'Usage: ./local-setup/proxy.sh {init|build|start|stop|status|login|devicelogin|test [model]}' ;;
esac
