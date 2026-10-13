# Deploying the pool on Proxmox with k3s and ARC

This sets up one VM that runs k3s, Actions Runner Controller (ARC) and spillway's discovery. Everything here is done by the operator on their own machines.

`deploy/install-from-wsl.sh` does all of the steps below in one run (network, VM from the Debian 13 cloud image, k3s, ARC, the App from a manifest, discovery and its timer). This page is the manual path and the reference for what the installer does. Versions below were the latest releases at least two weeks old on 2026-10-12; check for newer ones.

## 0. Plan the size

Each runner pod requests the CPU and memory in `defaults` (2 CPU, 4 GiB unless overridden). A VM with 4 vCPU and 10 GiB fits two runners plus k3s. Jobs beyond that wait. Give memory-hungry repositories their own `memory` in the config's `repos`.

## 1. An isolated network segment

The VM must reach GitHub over HTTPS and DNS, and nothing else on your network. One way on a Proxmox host is a bridge with no physical port plus NAT, with forwarding to private ranges dropped:

```bash
# On the Proxmox host. Pick a free bridge name and a private /24 not used on your LAN.
BR=vmbr99 NET=10.99.0 UPLINK=vmbr0
cat >> /etc/network/interfaces <<EOF

auto $BR
iface $BR inet static
    address $NET.1/24
    bridge-ports none
    bridge-stp off
    bridge-fd 0
    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s $NET.0/24 -o $UPLINK -j MASQUERADE
    post-up   iptables -I FORWARD -s $NET.0/24 -d 10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,169.254.0.0/16 -j DROP
    post-up   iptables -I INPUT -s $NET.0/24 -p tcp -j DROP
EOF
ifreload -a
```

Notes:

- If Docker runs on the Proxmox host, it sets the FORWARD policy to DROP; add an `ACCEPT` for the bridge's traffic after the DROP rules above.
- The INPUT rule keeps the VM away from the host's own services (web UI, SSH). DNS then has to come from outside the host: give the VM a public resolver.
- Check from inside the VM: `curl -sS -o /dev/null -w '%{http_code}\n' https://github.com` prints `200`, and your router and the Proxmox web UI do not answer.

## 2. The VM

Debian 13 (kernel 6.12) or another distribution with a recent kernel; jobs see the VM's kernel, so features such as Landlock ABI v6 depend on it. 4 vCPU, 10 GiB, 40 GB disk, on the bridge above, `onboot=1`. Install `curl`, `git`, `jq` and Node.js 22 or later.

## 3. k3s and Helm

```bash
K3S_VERSION=<a k3s release at least two weeks old>
curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - --disable traefik --disable servicelb
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get nodes
```

Install Helm from your distribution or from Helm's release page, verifying the checksum.

## 4. ARC controller

```bash
helm install arc --namespace arc-systems --create-namespace \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller --version 0.14.2
kubectl create namespace arc-runners
kubectl apply -f deploy/priorityclasses.yaml
```

The controller's service account is then `arc-gha-rs-controller` in `arc-systems`, which matches discovery's default `controllerServiceAccount`.

## 5. The GitHub App

In GitHub → Settings → Developer settings → GitHub Apps → New GitHub App, under your personal account:

- Webhook: **off** (uncheck "Active"). Nothing calls home.
- Repository permissions: **Administration: Read and write**, **Actions: Read-only**, **Metadata: Read-only**. Nothing else.
- Where can this app be installed: **Only on this account**.

Create it, generate a private key, and install it on **All repositories** (discovery serves only private repositories that opt in). Note the App ID (or client ID) and the installation ID (the number at the end of the installation's settings URL).

Move the key file to the VM without pasting its contents anywhere, then:

```bash
install -d -m 0700 /etc/spillway
install -m 0600 /path/to/downloaded-key.pem /etc/spillway/app.pem
APP_ID=<App ID or client ID> INSTALLATION_ID=<installation ID>
kubectl -n arc-runners create secret generic spillway-github-app \
  --from-literal=github_app_id="$APP_ID" \
  --from-literal=github_app_installation_id="$INSTALLATION_ID" \
  --from-file=github_app_private_key=/etc/spillway/app.pem
shred -u /path/to/downloaded-key.pem
```

## 6. Discovery

```bash
git clone --branch <release tag> https://github.com/rotep/spillway-ci /opt/spillway
cp /opt/spillway/spillway.config.example.json /etc/spillway/config.json   # then edit owner, appId, installationId
node /opt/spillway/discovery/main.mjs --config /etc/spillway/config.json            # plan
node /opt/spillway/discovery/main.mjs --config /etc/spillway/config.json --apply    # apply
cp /opt/spillway/deploy/systemd/spillway-discovery.* /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now spillway-discovery.timer
```

## 7. Check

- `kubectl -n arc-runners get autoscalingrunnersets` lists one entry per adopted repository.
- In each repository, Settings → Actions → Runners shows the scale set `spillway-<repository>` with the label `spillway`.
- Add the label `spillway` to a test pull request: the `spillway` workflow runs and `spillway / ci` turns green on the head commit. Compare with the hosted CI's result on the same commit.

## 8. Grow

- More capacity: add a node with the k3s agent (`K3S_URL`, `K3S_TOKEN`) on another VM on the same kind of segment.
- Priorities: set `priorityClassName` to `spillway-high` for repositories that should go first.
- Updates: bump the ARC chart and `runnerImage` in the config when new releases are out; discovery upgrades every scale set on its next run.
