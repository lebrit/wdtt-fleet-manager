#!/usr/bin/env bash
set -Eeuo pipefail
curl -fsSL https://raw.githubusercontent.com/lebrit/wdtt-fleet-manager/main/install.sh | sudo bash -s -- update
