#!/usr/bin/env bash
# Day-to-day operations on the pool, from a WSL or Linux shell in a clone of
# this repository. Each command makes one SSH connection to the Proxmox host,
# which hops into the pool VM with the key bootstrap-host.sh created there.
#
#   bash deploy/pool.sh status                  scale sets, pods, discovery timer and log
#   bash deploy/pool.sh plan                    what discovery would change
#   bash deploy/pool.sh apply                   make discovery's changes now
#   bash deploy/pool.sh include list
#   bash deploy/pool.sh include add <repo>      serve a repository before its workflow lands
#   bash deploy/pool.sh include remove <repo>
#   bash deploy/pool.sh update                  install this checkout's HEAD in the VM (code only;
#                                               config, key and cluster are kept), then plan
#
# Settings (environment): SPILLWAY_PVE_HOST (default pve-01), SPILLWAY_SSH
# (default ssh), SPILLWAY_NET (default 10.98.0, as in bootstrap-host.sh).

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PVE_HOST=${SPILLWAY_PVE_HOST:-pve-01}
SSH=${SPILLWAY_SSH:-ssh}
NET=${SPILLWAY_NET:-10.98.0}
[[ $NET =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "SPILLWAY_NET must look like 10.98.0." >&2; exit 1; }
HOP="ssh -i /root/.ssh/spillway_pool_ed25519 -o UserKnownHostsFile=/root/.ssh/spillway_known_hosts -o StrictHostKeyChecking=accept-new spillway@$NET.2"

die() { echo "ERROR: $*" >&2; exit 1; }
usage() { sed -n '5,13p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# Runs a script as root in the VM. The script travels on stdin through both
# hops, so nothing in it is parsed by the shells on the way.
in_vm() { "$SSH" "$PVE_HOST" "$HOP 'sudo bash -s'"; }

# Shell code for the VM: its $ expressions must reach the VM unexpanded.
# shellcheck disable=SC2016
PRELUDE='set -euo pipefail
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
CONFIG=/etc/spillway/config.json
discovery() { node /opt/spillway/discovery/main.mjs --config "$CONFIG" "$@" | grep -v "^skip" || true; }
set_include() {
  jq "$1" "$CONFIG" > "$CONFIG.new"
  chmod 600 "$CONFIG.new"
  mv "$CONFIG.new" "$CONFIG"
  jq -r ".include | if length == 0 then \"include: (empty)\" else \"include: \" + join(\" \") end" "$CONFIG"
}'

valid_repo() { [[ ${1:-} =~ ^[A-Za-z0-9._-]+$ ]] || die "\"${1:-}\" is not a repository name."; }

command=${1:-}
case "$command" in
  status)
    in_vm <<EOF
$PRELUDE
echo "== runner scale sets"; kubectl get autoscalingrunnersets -n arc-runners 2>/dev/null || echo "(none)"
echo; echo "== controller and listeners"; kubectl get pods -n arc-systems
echo; echo "== runners (one per running job)"; kubectl get pods -n arc-runners 2>/dev/null || true
echo; echo "== discovery"
echo "timer: \$(systemctl is-enabled spillway-discovery.timer 2>/dev/null || echo missing), \$(systemctl is-active spillway-discovery.timer 2>/dev/null || true)"
systemctl list-timers spillway-discovery.timer --no-pager --all | sed -n 2p
journalctl -u spillway-discovery.service -n 15 --no-pager -o cat | grep -v "^skip" || true
EOF
    ;;
  plan|apply)
    flag=; [ "$command" = apply ] && flag=--apply
    in_vm <<EOF
$PRELUDE
discovery $flag
EOF
    ;;
  include)
    case "${2:-}" in
      list) in_vm <<EOF
$PRELUDE
jq -r '.include[]?' "\$CONFIG"
EOF
        ;;
      add) valid_repo "${3:-}"; in_vm <<EOF
$PRELUDE
set_include '.include = ((.include // []) + ["$3"] | unique)'
discovery --apply
EOF
        ;;
      remove) valid_repo "${3:-}"; in_vm <<EOF
$PRELUDE
set_include '.include = ((.include // []) - ["$3"])'
discovery --apply
EOF
        ;;
      *) usage ;;
    esac
    ;;
  update)
    [ -z "$(git -C "$ROOT" status --porcelain)" ] || die "This checkout has uncommitted changes; update installs HEAD only."
    echo "Installing $(git -C "$ROOT" rev-parse --short HEAD) in the VM"
    git -C "$ROOT" archive --format=tar.gz HEAD \
      | "$SSH" "$PVE_HOST" "$HOP 'sudo rm -rf /opt/spillway.new && sudo mkdir -p /opt/spillway.new && sudo tar -xzf - -C /opt/spillway.new && sudo rm -rf /opt/spillway.prev && sudo mv /opt/spillway /opt/spillway.prev && sudo mv /opt/spillway.new /opt/spillway'"
    in_vm <<EOF
$PRELUDE
install -m 0644 /opt/spillway/deploy/systemd/spillway-discovery.service /opt/spillway/deploy/systemd/spillway-discovery.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now spillway-discovery.timer >/dev/null
echo "Installed; discovery timer \$(systemctl is-active spillway-discovery.timer). The previous code is in /opt/spillway.prev. Plan with the new code:"
discovery
EOF
    ;;
  *) usage ;;
esac
