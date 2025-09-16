 # Stop the current ClusterODM process
  if [[ -f clusterodm-tapis.pid ]]; then
      pid=$(cat clusterodm-tapis.pid)
      kill $pid
      rm -f clusterodm-tapis.pid
      echo "Stopped ClusterODM process $pid"
  else
      echo "No PID file found, trying to kill by name"
      pkill -f "node index.js.*tapis-config.json"
  fi

  # Wait a moment for cleanup
  sleep 3

  # Start ClusterODM-Tapis with the updated configuration
  nohup node index.js --asr tapis-config.json --port 3000 --admin-web-port 10000 >
  clusterodm-tapis.log 2>&1 &
  echo $! > clusterodm-tapis.pid

  # Verify it's running
  echo "ClusterODM-Tapis started with PID: $(cat clusterodm-tapis.pid)"