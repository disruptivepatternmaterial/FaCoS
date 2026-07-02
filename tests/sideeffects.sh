#!/bin/sh
# Layer 3: side-effect verification (MQTT + HA).
#
# Runs Node-RED in docker against this flow.json with a local mosquitto +
# tiny http echo for HA, then asserts that the spec-driven commands produce
# the four expected wire payloads:
#   set(11, switch[DCC4g])             -> mqtt trains/device/4 = 'g'
#   set(11, switch[DCC4r])             -> mqtt trains/device/4 = 'r'
#   set(1000, dir[0])                  -> mqtt trains/device/1000 = '0,0'
#   set(1000, speedstep[14], dir[1])   -> mqtt trains/device/1000 = '14,1'
#
# Requires: docker, mosquitto-clients (for `mosquitto_sub`), nc.
#
# This is the only test layer that needs full network + docker. Layer 2 +
# Layer 4 + Layer 5 (run-tests.sh) cover everything else without it.

set -eu
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "skip: docker not available"
  exit 0
fi
if ! command -v mosquitto_sub >/dev/null 2>&1; then
  echo "skip: mosquitto-clients not installed"
  exit 0
fi

# Stand up a throwaway mosquitto + Node-RED with this flow loaded.
docker rm -f facos-mosq facos-nr 2>/dev/null || true
docker run --rm -d --name facos-mosq -p 11883:1883 eclipse-mosquitto:2 \
  sh -c "echo 'allow_anonymous true' > /m.conf && echo 'listener 1883' >> /m.conf && exec mosquitto -c /m.conf" >/dev/null

# Build a stub flows.json with this flow + a stub broker config + a stub HA
# server so Node-RED loads cleanly. The real flow references config-node ids
# 4e91dd5ffb6a9ee8 (mqtt-broker) and 85b918fc1d4c8834 (server). We supply
# stubs with those exact ids so the import resolves.
jq -s '
  .[1] + .[0]
' flow.json - <<'JSON' > tests/test-flow.json
[
  {
    "id": "4e91dd5ffb6a9ee8",
    "type": "mqtt-broker",
    "name": "test-mosq",
    "broker": "host.docker.internal",
    "port": "11883",
    "clientid": "",
    "autoConnect": true,
    "usetls": false,
    "protocolVersion": "4",
    "keepalive": "60",
    "cleansession": true
  },
  {
    "id": "85b918fc1d4c8834",
    "type": "server",
    "name": "stub-ha",
    "addon": false,
    "rejectUnauthorizedCerts": true,
    "ha_boolean": "y|yes|true|on|home|open",
    "connectionDelay": false,
    "cacheJson": false,
    "heartbeat": false,
    "heartbeatInterval": 30
  }
]
JSON

mkdir -p tests/.nr-data
cp tests/test-flow.json tests/.nr-data/flows.json
docker run --rm -d --name facos-nr \
  -p 15471:15471 \
  --add-host host.docker.internal:host-gateway \
  -v "$PWD/tests/.nr-data:/data" \
  nodered/node-red:latest >/dev/null

# Wait for Node-RED tcp listener
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if nc -z localhost 15471 2>/dev/null; then break; fi
  sleep 1
done

trap 'docker rm -f facos-mosq facos-nr >/dev/null 2>&1 || true' EXIT

# Subscribe before sending
mosquitto_sub -h localhost -p 11883 -t 'trains/device/#' -v -W 8 > tests/.mqtt-cap.log &
SUBPID=$!
sleep 1

# Drive commands
{
  printf 'request(11, view, viewswitch)\n'
  printf 'set(11, switch[DCC4g])\n'
  sleep 0.3
  printf 'set(11, switch[DCC4r])\n'
  sleep 0.3
  printf 'request(1000, control)\n'
  printf 'set(1000, dir[0])\n'
  sleep 0.3
  printf 'set(1000, speedstep[14], dir[1])\n'
  sleep 0.5
} | nc -w 3 localhost 15471 > /dev/null

wait $SUBPID 2>/dev/null || true

ok=0
fail=0
for expect in 'trains/device/4 g' 'trains/device/4 r' 'trains/device/1000 0,0' 'trains/device/1000 14,1'; do
  if grep -F -- "$expect" tests/.mqtt-cap.log >/dev/null; then
    echo "ok:    $expect"
    ok=$((ok+1))
  else
    echo "FAIL:  $expect"
    fail=$((fail+1))
  fi
done

echo "captured payloads:"
cat tests/.mqtt-cap.log

if [ $fail -ne 0 ]; then
  echo "Layer 3 FAIL ($fail/$((ok+fail)))"
  exit 1
fi
echo "Layer 3 PASS ($ok/$((ok+fail)))"
