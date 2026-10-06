#!/usr/bin/env bash
# Deploys the tape CLI bundle + systemd timers to the recorder VM. Usage: TIMERS="atlas eval grade" deploy/install.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
pkg=$(dirname "$here")
repo=$(cd "$pkg/../.." && pwd)
vm=${VM:-slipway-recorder}
zone=${ZONE:-us-east1-b}
(cd "$pkg" && node scripts/bundle.mjs)
gcloud compute ssh "$vm" --zone "$zone" --command "rm -rf /tmp/slipway-tape && mkdir -p /tmp/slipway-tape"
gcloud compute scp --zone "$zone" "$pkg/bundle/cli.mjs" "$pkg/bundle/verify-cli.mjs" "$repo/eval/protocol.json" \
  "$here/tape.env" "$here/remote-install.sh" "$here"/slipway-*.service "$here"/slipway-*.timer "$vm:/tmp/slipway-tape/"
gcloud compute ssh "$vm" --zone "$zone" --command "sudo TIMERS='${TIMERS:-}' bash /tmp/slipway-tape/remote-install.sh"
