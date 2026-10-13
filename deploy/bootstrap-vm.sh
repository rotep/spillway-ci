#!/usr/bin/env bash
# Runs as root inside the pool VM (deploy/bootstrap-host.sh starts it).
# Installs Node.js, Helm and k3s at pinned versions (checksums verified where
# the project publishes them), Actions Runner Controller, the GitHub App's
# credentials, and spillway discovery with its timer. Safe to run again.
#
# stdin, first line: the address GitHub opened after "Create GitHub App".
# Needed only the first time, while /etc/spillway/app.pem does not exist.
#
# Settings (environment): SPILLWAY_OWNER (required), SPILLWAY_INCLUDE.

set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
OWNER=${SPILLWAY_OWNER:?SPILLWAY_OWNER is required}
INCLUDE=${SPILLWAY_INCLUDE:-}
DIR=/etc/spillway

# Pinned versions: releases at least two weeks old on 2026-10-12.
NODE_VERSION=v22.23.2
HELM_VERSION=v3.22.0
K3S_VERSION=v1.36.4+k3s1
ARC_VERSION=0.14.2

step() { printf '\n  -> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

redirect=
IFS= read -r redirect || true

[ "$(id -u)" = 0 ] || die "Run as root."
[[ $OWNER =~ ^[A-Za-z0-9-]+$ ]] || die "SPILLWAY_OWNER is not a GitHub user name."

step "Base packages"
export DEBIAN_FRONTEND=noninteractive
# On first boot cloud-init is still upgrading packages and holds the apt lock.
cloud-init status --wait >/dev/null 2>&1 || true
apt-get -o DPkg::Lock::Timeout=600 update -qq
apt-get -o DPkg::Lock::Timeout=600 install -y -qq curl ca-certificates jq xz-utils >/dev/null

if [ "$(node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  step "Node.js $NODE_VERSION"
  tmp=$(mktemp -d)
  file="node-$NODE_VERSION-linux-x64.tar.xz"
  curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt"
  curl -fsSL -o "$tmp/$file" "https://nodejs.org/dist/$NODE_VERSION/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --status) || die "Node.js checksum mismatch."
  rm -rf /opt/node && mkdir -p /opt/node && tar -xJf "$tmp/$file" -C /opt/node --strip-components=1
  ln -sf /opt/node/bin/node /usr/local/bin/node
  rm -rf "$tmp"
fi

if [ "$(helm version --template '{{.Version}}' 2>/dev/null || true)" != "$HELM_VERSION" ]; then
  step "Helm $HELM_VERSION"
  tmp=$(mktemp -d)
  file="helm-$HELM_VERSION-linux-amd64.tar.gz"
  curl -fsSL -o "$tmp/$file" "https://get.helm.sh/$file"
  curl -fsSL -o "$tmp/$file.sha256sum" "https://get.helm.sh/$file.sha256sum"
  (cd "$tmp" && sha256sum -c --status "$file.sha256sum") || die "Helm checksum mismatch."
  tar -xzf "$tmp/$file" -C "$tmp" linux-amd64/helm
  install -m 0755 "$tmp/linux-amd64/helm" /usr/local/bin/helm
  rm -rf "$tmp"
fi

if ! command -v k3s >/dev/null 2>&1; then
  step "k3s $K3S_VERSION"
  curl -sfL https://get.k3s.io \
    | INSTALL_K3S_VERSION="$K3S_VERSION" INSTALL_K3S_EXEC="--disable traefik --disable servicelb --write-kubeconfig-mode 600" sh -
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
for _ in $(seq 1 60); do
  kubectl get nodes 2>/dev/null | grep -q ' Ready ' && break
  sleep 5
done
kubectl get nodes | grep -q ' Ready ' || die "The k3s node did not become Ready."

step "Actions Runner Controller $ARC_VERSION"
helm upgrade --install arc oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
  --version "$ARC_VERSION" --namespace arc-systems --create-namespace --wait >/dev/null
kubectl create namespace arc-runners --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl apply -f "$SRC/deploy/priorityclasses.yaml" >/dev/null

step "GitHub App"
install -d -m 0700 "$DIR"
install_url=$(printf '%s\n' "$redirect" | node "$SRC/discovery/setup.mjs" convert --dir "$DIR")
# GitHub registers a manifest App only when the code is exchanged (just above),
# so it can be installed only now.
installation=
for i in $(seq 1 120); do
  if installation=$(node "$SRC/discovery/setup.mjs" installation --dir "$DIR" --owner "$OWNER" 2>/dev/null); then break; fi
  installation=
  if [ "$i" = 1 ]; then
    echo
    echo "     >>> Install the App now: open $install_url"
    echo "     >>> choose 'All repositories' and press 'Install'. Waiting up to 20 minutes."
    echo
  fi
  sleep 10
done
[ -n "$installation" ] || die "The App is not installed. Open $install_url, choose All repositories, install, and run the installer again."
printf '%s\n' "$installation" > "$DIR/installation-id"
kubectl -n arc-runners create secret generic spillway-github-app \
  --from-literal=github_app_id="$(jq -r .id "$DIR/app.json")" \
  --from-literal=github_app_installation_id="$installation" \
  --from-file=github_app_private_key="$DIR/app.pem" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
echo "     App $(jq -r .slug "$DIR/app.json"), installation $installation"

step "Discovery"
[ -f "$DIR/config.json" ] || node "$SRC/discovery/setup.mjs" config --dir "$DIR" --owner "$OWNER" --include "$INCLUDE" --out "$DIR/config.json" >/dev/null
# The timer first: a failing repository must not leave discovery unscheduled
# (the first real install stopped here under set -e and never enabled it).
install -m 0644 "$SRC/deploy/systemd/spillway-discovery.service" "$SRC/deploy/systemd/spillway-discovery.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now spillway-discovery.timer >/dev/null
node "$SRC/discovery/main.mjs" --config "$DIR/config.json" --apply \
  || echo "     Some repositories failed (see above). The timer retries every 5 minutes; fix and check with deploy/pool.sh status."

step "Runner scale sets"
kubectl -n arc-runners get autoscalingrunnersets 2>/dev/null || echo "     none yet: add .github/workflows/spillway.yml to a private repository, or list it in SPILLWAY_INCLUDE"
