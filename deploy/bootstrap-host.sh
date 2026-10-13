#!/usr/bin/env bash
# Runs as root on a Proxmox VE host (deploy/install-from-wsl.sh starts it).
# Creates an isolated bridge with NAT, a Debian 13 VM on it, copies this
# checkout into the VM and runs deploy/bootstrap-vm.sh there. Safe to run
# again: existing pieces are kept.
#
# stdin, first line: the address GitHub opened after "Create GitHub App"
# (passed on to the VM, where the App's key is created).
#
# Settings (environment), with defaults:
#   SPILLWAY_OWNER    (required) GitHub user that owns the repositories
#   SPILLWAY_INCLUDE  repositories to serve before their workflow lands
#   SPILLWAY_VM_NAME  spillway-pool        SPILLWAY_STORAGE local-zfs
#   SPILLWAY_BRIDGE   vmbr98               SPILLWAY_UPLINK  vmbr0
#   SPILLWAY_NET      10.98.0 (a /24 that your LAN does not use)
#   SPILLWAY_CORES    4    SPILLWAY_MEMORY 10240 (MiB)    SPILLWAY_DISK 40G
#   SPILLWAY_DNS      9.9.9.9 (the VM cannot reach the host, so not the host)

set -euo pipefail

SRC=$(cd "$(dirname "$0")/.." && pwd)
OWNER=${SPILLWAY_OWNER:?SPILLWAY_OWNER is required}
INCLUDE=${SPILLWAY_INCLUDE:-}
NAME=${SPILLWAY_VM_NAME:-spillway-pool}
BRIDGE=${SPILLWAY_BRIDGE:-vmbr98}
UPLINK=${SPILLWAY_UPLINK:-vmbr0}
NET=${SPILLWAY_NET:-10.98.0}
STORAGE=${SPILLWAY_STORAGE:-local-zfs}
CORES=${SPILLWAY_CORES:-4}
MEMORY=${SPILLWAY_MEMORY:-10240}
DISK=${SPILLWAY_DISK:-40G}
DNS=${SPILLWAY_DNS:-9.9.9.9}
IMAGE_DIR=/var/lib/spillway
IMAGE_NAME=debian-13-genericcloud-amd64.qcow2
IMAGE_BASE=https://cloud.debian.org/images/cloud/trixie/latest
KEY=/root/.ssh/spillway_pool_ed25519
KNOWN=/root/.ssh/spillway_known_hosts
VM_USER=spillway
VM_IP=$NET.2
VM=$VM_USER@$VM_IP

step() { printf '\n--> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

redirect=
IFS= read -r redirect || true

command -v qm >/dev/null 2>&1 || die "This is not a Proxmox VE host."
[ "$(id -u)" = 0 ] || die "Run as root."
[[ $OWNER =~ ^[A-Za-z0-9-]+$ ]] || die "SPILLWAY_OWNER is not a GitHub user name."
[[ $INCLUDE =~ ^[A-Za-z0-9._\ -]*$ ]] || die "SPILLWAY_INCLUDE may hold repository names and spaces only."
[[ $NET =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "SPILLWAY_NET must look like 10.98.0."
pvesm status | awk 'NR > 1 { print $1 }' | grep -qx "$STORAGE" || die "Storage $STORAGE does not exist (pvesm status)."
ip link show "$UPLINK" >/dev/null 2>&1 || die "Uplink bridge $UPLINK does not exist."

# Options go before the destination: vm_ssh [-n] "$VM" <command>.
vm_ssh() { ssh -i "$KEY" -o UserKnownHostsFile="$KNOWN" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 "$@"; }

# 1. Isolated bridge: NAT out through the uplink; nothing from the VM may reach
#    private, CGNAT or link-local ranges, or open connections to this host.
if ! grep -q "^iface $BRIDGE " /etc/network/interfaces; then
  ip route | grep -q "^$NET\." && die "$NET.0/24 is already routed on this host; set SPILLWAY_NET."
  step "Adding the isolated bridge $BRIDGE ($NET.0/24, NAT through $UPLINK)"
  cp /etc/network/interfaces "/etc/network/interfaces.spillway-backup.$(date +%Y%m%d%H%M%S)"
  cat >> /etc/network/interfaces <<EOF

# spillway: isolated segment for the CI runner VM (deploy/bootstrap-host.sh)
auto $BRIDGE
iface $BRIDGE inet static
    address $NET.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   sysctl -qw net.ipv4.ip_forward=1
    post-up   iptables -t nat -A POSTROUTING -s $NET.0/24 -o $UPLINK -j MASQUERADE
    post-up   iptables -A FORWARD -i $BRIDGE -j ACCEPT
    post-up   iptables -A FORWARD -o $BRIDGE -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
    post-up   iptables -I FORWARD -i $BRIDGE -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16 -j DROP
    post-up   iptables -I INPUT -i $BRIDGE -m conntrack ! --ctstate RELATED,ESTABLISHED -j DROP
EOF
  ifreload -a
else
  step "Bridge $BRIDGE already exists; keeping it"
fi

# 2. Debian 13 cloud image, checked against Debian's SHA512SUMS.
step "Fetching the Debian 13 cloud image"
mkdir -p "$IMAGE_DIR"
curl -fsSL -o "$IMAGE_DIR/SHA512SUMS" "$IMAGE_BASE/SHA512SUMS"
expected=$(awk -v f="$IMAGE_NAME" '$2 == f { print $1 }' "$IMAGE_DIR/SHA512SUMS")
[ -n "$expected" ] || die "$IMAGE_NAME is not listed in SHA512SUMS."
if ! echo "$expected  $IMAGE_DIR/$IMAGE_NAME" | sha512sum -c --status 2>/dev/null; then
  curl -fSL --progress-bar -o "$IMAGE_DIR/$IMAGE_NAME" "$IMAGE_BASE/$IMAGE_NAME"
  echo "$expected  $IMAGE_DIR/$IMAGE_NAME" | sha512sum -c --status || die "The image does not match SHA512SUMS."
fi

# 3. SSH key for this host to manage the VM.
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "spillway@$(hostname)" -f "$KEY"

# 4. The VM.
vmid=$(qm list | awk -v n="$NAME" '$2 == n { print $1 }')
if [ -z "$vmid" ]; then
  available=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo)
  if [ "$available" -lt $((MEMORY + 1024)) ] && [ "${SPILLWAY_FORCE:-}" != 1 ]; then
    die "Only ${available} MiB available; the VM needs ${MEMORY} MiB plus headroom. Lower SPILLWAY_MEMORY or set SPILLWAY_FORCE=1."
  fi
  vmid=$(pvesh get /cluster/nextid | tr -dc 0-9)
  step "Creating VM $vmid ($NAME): $CORES vCPU, $MEMORY MiB, $DISK on $STORAGE, $VM_IP on $BRIDGE"
  qm create "$vmid" --name "$NAME" --ostype l26 --cpu host --cores "$CORES" --memory "$MEMORY" \
    --net0 "virtio,bridge=$BRIDGE" --scsihw virtio-scsi-single \
    --scsi0 "$STORAGE:0,import-from=$IMAGE_DIR/$IMAGE_NAME,discard=on,ssd=1" \
    --ide2 "$STORAGE:cloudinit" --boot order=scsi0 --serial0 socket --vga serial0 --onboot 1 \
    --ciuser "$VM_USER" --sshkeys "$KEY.pub" --ipconfig0 "ip=$VM_IP/24,gw=$NET.1" --nameserver "$DNS" \
    --description "spillway CI runner pool (k3s + Actions Runner Controller). Created by deploy/bootstrap-host.sh."
  qm disk resize "$vmid" scsi0 "$DISK"
  ssh-keygen -q -R "$VM_IP" -f "$KNOWN" >/dev/null 2>&1 || true
else
  step "VM $vmid ($NAME) already exists; keeping it"
fi
[ "$(qm status "$vmid" | awk '{ print $2 }')" = running ] || qm start "$vmid"

step "Waiting for the VM to accept SSH"
for _ in $(seq 1 60); do
  vm_ssh -n "$VM" true 2>/dev/null && break
  sleep 5
done
vm_ssh -n "$VM" true || die "The VM did not come up on $VM_IP. Check its console: qm terminal $vmid"

# 5. This checkout into the VM, then the VM bootstrap.
step "Copying spillway into the VM"
tar -C "$SRC" -czf - . | vm_ssh "$VM" 'sudo rm -rf /opt/spillway.new && sudo mkdir -p /opt/spillway.new && sudo tar -xzf - -C /opt/spillway.new && sudo rm -rf /opt/spillway && sudo mv /opt/spillway.new /opt/spillway'

step "Running the VM bootstrap"
printf '%s\n' "$redirect" | vm_ssh "$VM" "sudo SPILLWAY_OWNER='$OWNER' SPILLWAY_INCLUDE='$INCLUDE' bash /opt/spillway/deploy/bootstrap-vm.sh"

step "Host side done: VM $vmid ($NAME) at $VM_IP on $BRIDGE"
