#!/usr/bin/env bash

# Restart helper for ClusterODM-Tapis running from this workspace.
# Ensures the instance comes back up with local download bypass enabled.

set -euo pipefail

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${BASE_DIR}"

PID_FILE="clusterodm-tapis.pid"
LOG_DIR="log"
LOG_RETENTION_DAYS="${LOG_RETENTION_DAYS:-7}"
LOG_FILE="${LOG_DIR}/clusterodm$(date +%Y%m%d).log"
ASR_CONFIG="tapis-config.json"
NODE_CONFIG="clusterodm-config.json"

if [[ ! -f "${ASR_CONFIG}" ]]; then
    echo "ASR config ${ASR_CONFIG} not found. Please create it before running restart.sh."
    exit 1
fi

if [[ ! -f "${NODE_CONFIG}" ]]; then
    echo "Node config ${NODE_CONFIG} not found. Please create it before running restart.sh."
    exit 1
fi

if command -v 7z >/dev/null 2>&1; then
    echo "7zip detected: $(command -v 7z)"
else
    echo "WARNING: 7zip not found. Install 7zip to enable seed.zip repair."
fi

# Allow overrides via environment variables, but fall back to defaults.
PORT="${PORT:-3000}"
ADMIN_WEB_PORT="${ADMIN_WEB_PORT:-10000}"

if ! [[ "${LOG_RETENTION_DAYS}" =~ ^[0-9]+$ ]] || (( LOG_RETENTION_DAYS < 1 )); then
    echo "LOG_RETENTION_DAYS must be a positive integer."
    exit 1
fi

prune_clusterodm_logs() {
    mkdir -p "${LOG_DIR}"
    find "${LOG_DIR}" -maxdepth 1 -type f -name 'clusterodm*.log' -mtime +"$((LOG_RETENTION_DAYS - 1))" -delete
}

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

TMP_DIR_ARG="${TMP_DIR:-/corral/clusterodm/tmp}"

start_clusterodm() {
    prune_clusterodm_logs
    echo "Starting ClusterODM-Tapis on port ${PORT} (admin web ${ADMIN_WEB_PORT}), tmp dir ${TMP_DIR_ARG}"
    node index.js \
        --asr "${ASR_CONFIG}" \
        --config "${NODE_CONFIG}" \
        --port "${PORT}" \
        --admin-web-port "${ADMIN_WEB_PORT}" \
        --allow-local-download-bypass true \
        --tmp-dir "${TMP_DIR_ARG}" \
        >> "${LOG_FILE}" 2>&1 &

    echo $! > "${PID_FILE}"
    echo "ClusterODM-Tapis started with PID: $(cat "${PID_FILE}")"
    echo "Logs: ${LOG_FILE}"
}

stop_clusterodm
sleep 3
start_clusterodm
