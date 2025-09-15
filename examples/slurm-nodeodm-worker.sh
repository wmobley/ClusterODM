#!/bin/bash
#SBATCH --job-name=nodeodm-worker
#SBATCH --nodes=1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=2
#SBATCH --mem=8GB
#SBATCH --time=02:00:00
#SBATCH --partition=compute

# Example SLURM script for running NodeODM with automatic cluster registration
# This script demonstrates how to integrate the webhook registration system
# with HPC job schedulers like SLURM.

set -e

echo "========================================"
echo "NodeODM Worker with Auto-Registration"
echo "Job ID: $SLURM_JOB_ID"
echo "Node: $SLURMD_NODENAME"
echo "========================================"

# Configuration - Modify these for your environment
CLUSTER_HOST="${CLUSTER_HOST:-head-node.cluster.edu}"
CLUSTER_PORT="${CLUSTER_PORT:-10000}"
TAPIS_TOKEN="${TAPIS_TOKEN:-}"
REGISTRATION_SECRET="${REGISTRATION_SECRET:-your-shared-secret}"
NODE_PORT="${NODE_PORT:-3000}"

# Get the node's IP address (different methods for different systems)
if command -v hostname >/dev/null 2>&1; then
    # Try different hostname options
    NODE_HOST=$(hostname -i 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || hostname)
elif command -v ip >/dev/null 2>&1; then
    # Fallback to ip command
    NODE_HOST=$(ip route get 1 2>/dev/null | awk '{print $7; exit}')
else
    # Last resort
    NODE_HOST=$(cat /etc/hostname 2>/dev/null || echo "unknown")
fi

echo "Configuration:"
echo "  Cluster: $CLUSTER_HOST:$CLUSTER_PORT"
echo "  Node: $NODE_HOST:$NODE_PORT"
echo "  Auth: $([ -n "$TAPIS_TOKEN" ] && echo "Tapis JWT" || [ -n "$REGISTRATION_SECRET" ] && echo "Secret" || echo "none")"
echo ""

# Function to cleanup on exit
cleanup() {
    echo "Cleaning up..."

    # De-register from cluster first
    echo "De-registering node from cluster..."
    if [[ -f "./deregister-node.sh" ]]; then
        echo "Using deregister-node.sh script..."
        export CLUSTER_HOST
        export CLUSTER_PORT
        export NODE_HOST
        export NODE_PORT
        export TAPIS_TOKEN
        export REGISTRATION_SECRET
        ./deregister-node.sh
    elif [[ -f "./register-node.sh" ]]; then
        echo "Using register-node.sh with --deregister flag..."
        export CLUSTER_HOST
        export CLUSTER_PORT
        export NODE_HOST
        export NODE_PORT
        export TAPIS_TOKEN
        export REGISTRATION_SECRET
        ./register-node.sh --deregister
    elif command -v node >/dev/null 2>&1 && [[ -f "./register-node.js" ]]; then
        echo "Using register-node.js with --deregister flag..."
        if [[ -n "$TAPIS_TOKEN" ]]; then
            node register-node.js \
                --cluster-host "$CLUSTER_HOST" \
                --cluster-port "$CLUSTER_PORT" \
                --node-host "$NODE_HOST" \
                --node-port "$NODE_PORT" \
                --tapis-token "$TAPIS_TOKEN" \
                --deregister
        else
            node register-node.js \
                --cluster-host "$CLUSTER_HOST" \
                --cluster-port "$CLUSTER_PORT" \
                --node-host "$NODE_HOST" \
                --node-port "$NODE_PORT" \
                --registration-secret "$REGISTRATION_SECRET" \
                --deregister
        fi
    else
        echo "Using curl for de-registration..."
        # Build payload with appropriate authentication
        if [[ -n "$TAPIS_TOKEN" ]]; then
            PAYLOAD=$(cat <<EOF
{
    "hostname": "$NODE_HOST",
    "port": $NODE_PORT,
    "tapisToken": "$TAPIS_TOKEN"
}
EOF
            )
        else
            PAYLOAD=$(cat <<EOF
{
    "hostname": "$NODE_HOST",
    "port": $NODE_PORT,
    "registrationSecret": "$REGISTRATION_SECRET"
}
EOF
            )
        fi

        DEREGISTRATION_URL="http://$CLUSTER_HOST:$CLUSTER_PORT/webhook/deregister-node"

        echo "Attempting to de-register node $NODE_HOST:$NODE_PORT..."
        response=$(curl -s -w "%{http_code}" \
                      -X POST \
                      -H "Content-Type: application/json" \
                      -d "$PAYLOAD" \
                      --connect-timeout 10 \
                      --max-time 30 \
                      "$DEREGISTRATION_URL" 2>/dev/null || echo "000")

        http_code="${response: -3}"
        response_body="${response%???}"

        if [[ "$http_code" == "200" ]]; then
            echo "✅ Successfully de-registered from cluster!"
        elif [[ "$http_code" == "404" ]]; then
            echo "⚠️  Node not found in cluster (may already be removed)"
        else
            echo "⚠️  De-registration failed (HTTP $http_code), but continuing cleanup..."
        fi
    fi

    # Stop NodeODM
    if [[ -n "$NODEODM_PID" ]]; then
        echo "Stopping NodeODM (PID: $NODEODM_PID)"
        kill $NODEODM_PID 2>/dev/null || true
        wait $NODEODM_PID 2>/dev/null || true
    fi

    echo "Cleanup completed"
}

# Set up signal handlers
trap cleanup EXIT SIGTERM SIGINT

# Load required modules (adjust for your HPC environment)
echo "Loading required modules..."
module load apptainer 2>/dev/null || module load singularity 2>/dev/null || echo "No container module loaded"

# Start NodeODM
echo "Starting NodeODM on port $NODE_PORT..."

# Method 1: Using Apptainer/Singularity (most common in HPC)
if command -v apptainer >/dev/null 2>&1; then
    echo "Using Apptainer to run NodeODM..."
    apptainer run \
        --bind /tmp:/tmp \
        --bind /scratch:/scratch \
        docker://opendronemap/nodeodm \
        --port $NODE_PORT \
        --parallel 2 \
        --max_images 500 &
    NODEODM_PID=$!

elif command -v singularity >/dev/null 2>&1; then
    echo "Using Singularity to run NodeODM..."
    singularity run \
        --bind /tmp:/tmp \
        --bind /scratch:/scratch \
        docker://opendronemap/nodeodm \
        --port $NODE_PORT \
        --parallel 2 \
        --max_images 500 &
    NODEODM_PID=$!

elif command -v docker >/dev/null 2>&1; then
    echo "Using Docker to run NodeODM..."
    docker run \
        --rm \
        -p $NODE_PORT:$NODE_PORT \
        -v /tmp:/tmp \
        opendronemap/nodeodm \
        --port $NODE_PORT \
        --parallel 2 \
        --max_images 500 &
    NODEODM_PID=$!

else
    echo "❌ No container runtime found (apptainer, singularity, or docker)"
    echo "Please install a container runtime or modify this script to run NodeODM directly"
    exit 1
fi

echo "NodeODM started with PID: $NODEODM_PID"

# Wait for NodeODM to start up
echo "Waiting for NodeODM to start (up to 60 seconds)..."
WAIT_COUNT=0
while [[ $WAIT_COUNT -lt 60 ]]; do
    if curl -s "http://localhost:$NODE_PORT/info" >/dev/null 2>&1; then
        echo "✅ NodeODM is ready!"
        break
    fi
    sleep 1
    WAIT_COUNT=$((WAIT_COUNT + 1))
    if [[ $((WAIT_COUNT % 10)) -eq 0 ]]; then
        echo "Still waiting for NodeODM... (${WAIT_COUNT}s)"
    fi
done

if [[ $WAIT_COUNT -ge 60 ]]; then
    echo "❌ NodeODM failed to start within 60 seconds"
    exit 1
fi

# Register with the cluster
echo "Registering with ClusterODM cluster..."

# Use the registration script if available
if [[ -f "./register-node.sh" ]]; then
    echo "Using register-node.sh script..."
    export CLUSTER_HOST
    export CLUSTER_PORT
    export NODE_HOST
    export NODE_PORT
    export TAPIS_TOKEN
    export REGISTRATION_SECRET
    ./register-node.sh
elif command -v node >/dev/null 2>&1 && [[ -f "./register-node.js" ]]; then
    echo "Using register-node.js script..."
    if [[ -n "$TAPIS_TOKEN" ]]; then
        node register-node.js \
            --cluster-host "$CLUSTER_HOST" \
            --cluster-port "$CLUSTER_PORT" \
            --node-host "$NODE_HOST" \
            --node-port "$NODE_PORT" \
            --tapis-token "$TAPIS_TOKEN"
    else
        node register-node.js \
            --cluster-host "$CLUSTER_HOST" \
            --cluster-port "$CLUSTER_PORT" \
            --node-host "$NODE_HOST" \
            --node-port "$NODE_PORT" \
            --registration-secret "$REGISTRATION_SECRET"
    fi
else
    echo "Using curl for registration..."
    # Fallback to direct curl registration
    # Build payload with appropriate authentication
    if [[ -n "$TAPIS_TOKEN" ]]; then
        PAYLOAD=$(cat <<EOF
{
    "hostname": "$NODE_HOST",
    "port": $NODE_PORT,
    "tapisToken": "$TAPIS_TOKEN"
}
EOF
        )
    else
        PAYLOAD=$(cat <<EOF
{
    "hostname": "$NODE_HOST",
    "port": $NODE_PORT,
    "registrationSecret": "$REGISTRATION_SECRET"
}
EOF
        )
    fi

    REGISTRATION_URL="http://$CLUSTER_HOST:$CLUSTER_PORT/webhook/register-node"

    for attempt in {1..5}; do
        echo "Registration attempt $attempt/5..."

        if response=$(curl -s -w "%{http_code}" \
                          -X POST \
                          -H "Content-Type: application/json" \
                          -d "$PAYLOAD" \
                          --connect-timeout 30 \
                          --max-time 60 \
                          "$REGISTRATION_URL" 2>/dev/null); then

            http_code="${response: -3}"
            response_body="${response%???}"

            if [[ "$http_code" == "200" ]]; then
                echo "✅ Successfully registered with cluster!"
                echo "Response: $response_body"
                break
            else
                echo "❌ Registration failed (HTTP $http_code): $response_body"
            fi
        else
            echo "❌ Failed to connect to cluster"
        fi

        if [[ $attempt -lt 5 ]]; then
            echo "Retrying in 10 seconds..."
            sleep 10
        fi
    done
fi

echo ""
echo "========================================"
echo "NodeODM Worker is ready!"
echo "Node: $NODE_HOST:$NODE_PORT"
echo "Cluster: $CLUSTER_HOST:$CLUSTER_PORT"
echo "Job will run until time limit or cancellation"
echo "========================================"

# Keep the job running and monitor NodeODM
while kill -0 $NODEODM_PID 2>/dev/null; do
    sleep 30

    # Optional: Periodically check NodeODM health
    if ! curl -s "http://localhost:$NODE_PORT/info" >/dev/null 2>&1; then
        echo "⚠️  NodeODM health check failed, process may have died"
        break
    fi
done

echo "NodeODM process has stopped"
wait $NODEODM_PID 2>/dev/null || true
echo "Job completed"