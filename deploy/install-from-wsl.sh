#!/usr/bin/env bash
# One-command install of the spillway pool, run from a WSL (or Linux) shell on
# the operator's PC inside a clone of this repository:
#
#   SPILLWAY_PVE_HOST=pve-01 SPILLWAY_INCLUDE="repo1 repo2" bash deploy/install-from-wsl.sh
#
# What it does, in order:
#   1. checks that `ssh <host>` reaches the Proxmox host as root without a prompt;
#   2. opens a local page that sends the GitHub App manifest to GitHub; you press
#      "Create GitHub App", then paste back the address GitHub opens (?code=...);
#   3. copies this checkout to the host and runs deploy/bootstrap-host.sh there,
#      which builds the isolated network and the VM and runs
#      deploy/bootstrap-vm.sh inside it (k3s, ARC, the App's key, discovery).
#      Near the end the host's output asks you to install the App (GitHub
#      registers a manifest App only once the VM exchanges the code): open the
#      link, choose "All repositories", install.
#      If `ssh <host>` does not work without a prompt (Windows ssh.exe first,
#      then the WSL ssh), it prints one line to
#      paste into the host's Shell in the Proxmox web UI instead (no SSH needed;
#      the host downloads this commit from GitHub through a 5-minute link).
# The App's private key is created by GitHub and written only inside the VM.
# The address from step 2 is kept for 55 minutes in ~/.cache/spillway, so a
# second run within that time reuses it instead of creating another App.
#
# Settings (environment):
#   SPILLWAY_PVE_HOST  ssh destination of the Proxmox host (default pve-01)
#   SPILLWAY_SSH       ssh client (default: ssh.exe if it works without a prompt,
#                      else the WSL ssh)
#   SPILLWAY_OWNER     GitHub user that owns the repositories (default: the owner
#                      in this checkout's origin URL)
#   SPILLWAY_APP_NAME  App name (default spillway-<owner>; must be unique on GitHub)
#   SPILLWAY_INCLUDE   repositories to serve before their spillway workflow
#                      reaches the default branch (space separated)
# bootstrap-host.sh reads more (bridge, network, storage, size); see its header.

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CACHE=${XDG_CACHE_HOME:-$HOME/.cache}/spillway
PVE_HOST=${SPILLWAY_PVE_HOST:-pve-01}
ORIGIN=$(git -C "$ROOT" remote get-url origin)
OWNER=${SPILLWAY_OWNER:-$(printf '%s' "$ORIGIN" | sed -E 's#^.*github\.com[:/]([^/]+)/.*$#\1#')}
REPO=$(printf '%s' "$ORIGIN" | sed -E 's#^.*github\.com[:/][^/]+/([^/]+)$#\1#; s#\.git$##')
APP_NAME=${SPILLWAY_APP_NAME:-spillway-$OWNER}
INCLUDE=${SPILLWAY_INCLUDE:-}
SSH=${SPILLWAY_SSH:-}

# Host settings that bootstrap-host.sh reads, passed on when set here.
host_env="SPILLWAY_OWNER='$OWNER' SPILLWAY_INCLUDE='${SPILLWAY_INCLUDE:-}'"
for var in SPILLWAY_VM_NAME SPILLWAY_STORAGE SPILLWAY_BRIDGE SPILLWAY_UPLINK SPILLWAY_NET SPILLWAY_CORES SPILLWAY_MEMORY SPILLWAY_DISK SPILLWAY_DNS SPILLWAY_FORCE; do
  value=${!var:-}
  [ -z "$value" ] && continue
  [[ $value =~ ^[A-Za-z0-9._-]+$ ]] || { printf 'ERROR: %s has characters other than letters, digits, dot, underscore and hyphen.\n' "$var" >&2; exit 1; }
  host_env+=" $var='$value'"
done

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[[ $OWNER =~ ^[A-Za-z0-9-]+$ ]] || die "Could not tell the GitHub owner; set SPILLWAY_OWNER."
[[ $INCLUDE =~ ^[A-Za-z0-9._\ -]*$ ]] || die "SPILLWAY_INCLUDE may hold repository names and spaces only."
[[ $APP_NAME =~ ^[A-Za-z0-9-]+$ ]] || die "SPILLWAY_APP_NAME may hold letters, digits and hyphens only."
command -v node >/dev/null 2>&1 || die "Node.js 22 or later is needed on this PC."
[ -z "$(git -C "$ROOT" status --porcelain)" ] || die "This checkout has uncommitted changes; the host gets HEAD only. Commit or stash them first."

open_in_browser() {
  local target=$1
  if command -v cmd.exe >/dev/null 2>&1; then
    (cd /mnt/c && cmd.exe /c start "" "$target") >/dev/null 2>&1 && return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$target" >/dev/null 2>&1 && return 0; fi
  echo "Open this in your browser: $target"
}

cat <<EOF

spillway installer
  Proxmox host : $PVE_HOST (via ${SSH:-ssh.exe or ssh}, or the Proxmox web shell if SSH does not work)
  GitHub owner : $OWNER
  App name     : $APP_NAME
  Include      : ${INCLUDE:-"(none)"}

On the host this adds an isolated bridge with NAT (no access to your LAN or the
host), downloads the Debian 13 cloud image, and creates one VM. Inside the VM it
installs k3s, Helm and Actions Runner Controller, and starts discovery.
EOF
read -r -p "Continue? [y/N] " answer
[[ $answer =~ ^[Yy]$ ]] || die "Stopped."

step "Checking SSH to $PVE_HOST"
route=webshell
candidates=$SSH
[ -n "$candidates" ] || candidates="ssh.exe ssh"
for client in $candidates; do
  command -v "$client" >/dev/null 2>&1 || continue
  if "$client" -o BatchMode=yes -o ConnectTimeout=10 "$PVE_HOST" 'pveversion' 2>/dev/null; then
    SSH=$client
    route=ssh
    break
  fi
done
if [ "$route" = webshell ]; then
  echo "SSH to $PVE_HOST as root without a prompt did not work. The installer will print one line"
  echo "to paste into the host's Shell in the Proxmox web UI instead."
  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    die "That route needs an authenticated gh on this PC (gh auth login)."
  fi
  head_sha=$(git -C "$ROOT" rev-parse HEAD)
  git -C "$ROOT" fetch -q origin
  [ -n "$(git -C "$ROOT" branch -r --contains "$head_sha")" ] || die "HEAD $head_sha is not on GitHub; push it first."
fi

mkdir -p "$CACHE" && chmod 700 "$CACHE"
saved="$CACHE/app-redirect"
redirect=
if [ -f "$saved" ] && [ -n "$(find "$saved" -mmin -55 2>/dev/null)" ]; then
  redirect=$(cat "$saved")
  step "Reusing the App address from the last run (less than 55 minutes old)"
else
  step "Creating the GitHub App (in your browser)"
  html_dir=$ROOT
  if command -v cmd.exe >/dev/null 2>&1; then
    win_temp=$(cd /mnt/c && cmd.exe /c 'echo %TEMP%' 2>/dev/null | tr -d '\r')
    [ -n "$win_temp" ] && html_dir=$(wslpath "$win_temp")
  fi
  html="$html_dir/spillway-app.html"
  node "$ROOT/discovery/setup.mjs" html --owner "$OWNER" --name "$APP_NAME" --out "$html" >/dev/null
  if command -v wslpath >/dev/null 2>&1; then open_in_browser "$(wslpath -w "$html")"; else open_in_browser "$html"; fi
  echo "In the browser: press 'Continue to GitHub', check the name, press 'Create GitHub App'."
  read -r -p "Paste the whole address GitHub opened afterwards (it contains ?code=): " pasted
  rm -f "$html"
  code=$(printf '%s' "$pasted" | sed -nE 's/.*[?&]code=([A-Za-z0-9_-]+).*/\1/p')
  [ -n "$code" ] || die "That address has no ?code=. Run the installer again."
  redirect="?code=$code"
  (umask 077 && printf '%s\n' "$redirect" > "$saved")

  echo "Later, the host's output asks you to install the App: open that link, choose 'All repositories', install."
fi

if [ "$route" = ssh ]; then
  step "Copying spillway ($(git -C "$ROOT" rev-parse --short HEAD)) to $PVE_HOST"
  git -C "$ROOT" archive --format=tar.gz HEAD | base64 -w0 \
    | "$SSH" "$PVE_HOST" 'rm -rf /root/spillway-src && mkdir -p /root/spillway-src && base64 -d | tar -xz -C /root/spillway-src'

  step "Running the host bootstrap on $PVE_HOST (about 10 minutes)"
  printf '%s\n' "$redirect" | "$SSH" "$PVE_HOST" "$host_env bash /root/spillway-src/deploy/bootstrap-host.sh"
  step "Done. Discovery now runs every 5 minutes inside the VM."
else
  # A private repository's tarball link carries a token that expires after 5 minutes.
  url=$(curl -fsS -o /dev/null -w '%{redirect_url}' \
    -H "Authorization: Bearer $(gh auth token)" -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$OWNER/$REPO/tarball/$head_sha")
  [[ $url =~ ^https://[A-Za-z0-9./_?=\&%-]+$ ]] || die "GitHub did not give a download link for $head_sha."
  step "Paste the line below into $PVE_HOST's Shell in the Proxmox web UI (select the node, then Shell) within 5 minutes"
  printf '\n%s\n\n' "rm -rf /root/spillway-src && mkdir -p /root/spillway-src && curl -fsSL '$url' | tar -xz --strip-components=1 -C /root/spillway-src && printf '%s\n' '$redirect' | $host_env bash /root/spillway-src/deploy/bootstrap-host.sh"
  echo "It runs about 10 minutes there. When it shows '>>> Install the App now', open that link, choose 'All repositories', install."
  echo "It ends with the list of runner scale sets."
  echo "If the link expired, run this installer again within the hour: it reuses the App and prints a fresh line."
fi
