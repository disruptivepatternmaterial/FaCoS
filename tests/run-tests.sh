#!/bin/sh
# FaCoS test runner. Runs:
#   Layer 1: parser unit tests (node tests/parser-unit.js)
#   Layer 2: scripted-session diff (pure node, no docker required)
#   Layer 4: multi-session view fan-out (pure node)
#   Layer 5: byte-identical sidewires diff (jq vs production export)
#
# Layer 3 (mqtt + ha) lives in `sideeffects.sh` and needs a local mosquitto;
# run it manually when you want to verify the wire side.
set -eu
cd "$(dirname "$0")/.."

fail=0

echo "=== Layer 1: parser unit ==="
if node tests/parser-unit.js; then
  echo
else
  echo "FAIL Layer 1"
  fail=1
fi

echo "=== Layer 2: scripted-session diff ==="
node tests/run-session.js > tests/actual-replies.txt
if diff -u tests/expected-replies.txt tests/actual-replies.txt; then
  echo "PASS Layer 2"
else
  echo "FAIL Layer 2"
  fail=1
fi

echo "=== Layer 4: multi-session view fan-out ==="
if node tests/multi-session.js; then
  :
else
  echo "FAIL Layer 4"
  fail=1
fi

echo "=== Layer 5: sidewires byte-identical ==="
if bash tests/diff-sidewires.sh; then
  :
else
  echo "FAIL Layer 5"
  fail=1
fi

if [ $fail -ne 0 ]; then
  echo
  echo "OVERALL: FAIL"
  exit 1
fi
echo
echo "OVERALL: PASS"
