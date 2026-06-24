#!/usr/bin/env bash
set -Eeuo pipefail

REPOSITORY="${WDTT_FLEET_REPOSITORY:-lebrit/wdtt-fleet-manager}"
BRANCH="${WDTT_FLEET_BRANCH:-main}"
SCRIPT_URL="https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}/install.sh"
TEMP_SCRIPT="$(mktemp)"
trap 'rm -f "$TEMP_SCRIPT"' EXIT

curl -fsSL "$SCRIPT_URL" -o "$TEMP_SCRIPT"
bash "$TEMP_SCRIPT" "$@"
