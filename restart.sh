#!/usr/bin/env bash

# Restart helper for ClusterODM-Tapis running from this workspace.
# Ensures the instance comes back up with local download bypass enabled.

set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${BASE_DIR}"

PID_FILE="clusterodm-tapis.pid"
LOG_FILE="clusterodm-tapis.log"
ASR_CONFIG="tapis-config.json"

# Allow overrides via environment variables, but fall back to defaults.
PORT="${PORT:-3000}"
ADMIN_WEB_PORT="${ADMIN_WEB_PORT:-10000}"

stop_clusterodm() {
    if [[ -f "${PID_FILE}" ]]; then
        local pid
        pid="$(cat "${PID_FILE}")"
        if kill "${pid}" >/dev/null 2>&1; then
            echo "Stopped ClusterODM process ${pid}"
        fi
        rm -f "${PID_FILE}"
    else
        echo "No PID file found, attempting to stop running instance by command match"
        pkill -f "node index.js.*${ASR_CONFIG}" >/dev/null 2>&1 || true
    fi
}

start_clusterodm() {
    echo "Starting ClusterODM-Tapis on port ${PORT} (admin web ${ADMIN_WEB_PORT})"
    node index.js \
        --asr "${ASR_CONFIG}" \
        --port "${PORT}" \
        --admin-web-port "${ADMIN_WEB_PORT}" \
        --allow-local-download-bypass true \
        > "${LOG_FILE}" 2>&1 &

    echo $! > "${PID_FILE}"
    echo "ClusterODM-Tapis started with PID: $(cat "${PID_FILE}")"
    echo "Logs: ${LOG_FILE}"
}

stop_clusterodm
sleep 3
start_clusterodm
