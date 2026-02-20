#!/bin/bash
set -e

echo "Starting NGINX Active-Passive Failover demonstration..."

echo "1. Checking if US region is up and handling its own traffic..."
STATUS=$(curl -o /dev/null -s -w "%{http_code}\n" http://localhost:8080/us/health)
if [ "$STATUS" -eq 200 ]; then
  echo "US region is ONLINE and returned 200 OK."
else
  echo "Expected 200 OK from US region, but got $STATUS"
  exit 1
fi

echo "2. Stopping the backend-us container to simulate an outage..."
docker stop backend-us
sleep 3

echo "3. Sending request to US region (/us/health) again..."
STATUS=$(curl -o /dev/null -s -w "%{http_code}\n" http://localhost:8080/us/health)
if [ "$STATUS" -eq 200 ]; then
  echo "Request succeeded with 200 OK! Failover routing is working."
else
  echo "Failover routing failed! Got $STATUS"
  exit 1
fi

echo "4. Checking backend-eu logs to verify it intercepted the /us/ traffic..."
if docker logs backend-eu --tail 15 | grep -q "GET /us/health"; then
  echo "Successfully detected 'GET /us/health' in backend-eu logs."
else
  echo "Could not find 'GET /us/health' in backend-eu logs (Check if it's there manually)."
fi

echo "5. Restarting backend-us to restore typical service..."
docker start backend-us
sleep 3

echo "Demonstration complete."
