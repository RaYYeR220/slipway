#!/usr/bin/env bash
# Runs on the VM (as root): installs the tape CLI next to the recorder and (re)enables the requested timers.
# The recorder service and its data directory are not touched.
set -euo pipefail
src=/tmp/slipway-tape
install -d -o slipway -g slipway -m 0755 /opt/slipway/app /opt/slipway/work
install -o slipway -g slipway -m 0644 "$src"/cli.mjs "$src"/verify-cli.mjs "$src"/protocol.json "$src"/tape.env /opt/slipway/app/
install -m 0644 "$src"/slipway-{atlas,eval,grade,anchor}.service "$src"/slipway-{atlas,eval,grade,anchor}.timer /etc/systemd/system/
systemctl daemon-reload
for t in ${TIMERS:-}; do systemctl enable --now "slipway-$t.timer"; done
systemctl list-timers 'slipway-*' --no-pager
