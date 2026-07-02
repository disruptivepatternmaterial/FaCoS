#!/bin/sh
# Layer 5: confirm the four sidewire keepers are byte-identical to the
# production export. The wires (output connections) are allowed to differ;
# the function bodies and change rules are not.
#
# Usage: bash tests/diff-sidewires.sh [path/to/production/flows.json]
# Default production source: /Volumes/home-BowmanMtn/docker/node-red/projects/bowman-mtn-node-red/flows.json
set -eu

cd "$(dirname "$0")/.."

PROD="${1:-/Volumes/home-BowmanMtn/docker/node-red/projects/bowman-mtn-node-red/flows.json}"
NEW=flow.json

if [ ! -r "$PROD" ]; then
  echo "skip: production flow not readable at $PROD"
  exit 0
fi

KEEPERS='160be93ff00baee4 affe2618d7b80853 27d8ff35b4e13404 4e2cc9eb2ddadad8 7485938bd6ccdaec f235fbbc2f3535a6 b13bfa380f4582a8 8759c8a437d1bfc1 cfd7460388fc6861 b922981349a7ceb7 24dc6b2d70f47d9e 4721cdc23d5f9473 3843a287d6cf613b 1bf2aa2b2ca64b87'

fail=0
for id in $KEEPERS; do
  # Compare the body that matters: type + name + (.func // .rules // .entityId // .topic).
  prod=$(jq -S --arg id "$id" '
    .[] | select(.id == $id) |
    { type, name, func: (.func // null), rules: (.rules // null), entityId: (.entityId // null), action: (.action // null), topic: (.topic // null), property: (.property // null), service: (.service // null) }
  ' "$PROD")
  new=$(jq -S --arg id "$id" '
    .[] | select(.id == $id) |
    { type, name, func: (.func // null), rules: (.rules // null), entityId: (.entityId // null), action: (.action // null), topic: (.topic // null), property: (.property // null), service: (.service // null) }
  ' "$NEW")
  if [ "$prod" != "$new" ]; then
    fail=1
    echo "DRIFT: $id"
    diff <(printf '%s\n' "$prod") <(printf '%s\n' "$new") || true
  else
    echo "ok:    $id"
  fi
done

if [ $fail -ne 0 ]; then
  echo "FAIL: at least one sidewire drifted"
  exit 1
fi
echo "PASS: all sidewires byte-identical"
