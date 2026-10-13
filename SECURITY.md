# Security

spillway makes pull request code run on hardware you own. Read this before deploying it.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). Do not open a public issue for a vulnerability.

## Threat model

### Assets

- The home network and the hypervisor (Proxmox host) under the pool.
- The GitHub App's private key. The App needs **Administration: read and write** on each served repository, because registering repository-scoped runners requires it. A leaked key gives that power over every repository the App is installed on.
- The integrity of CI results that people and agents use to decide merges.

### Trust assumptions

- Only the owner and agents acting for the owner write code to the served repositories. spillway is not a sandbox for strangers' code.
- GitHub, the ARC controller and the official runner image are trusted.

### Controls

| Threat | Control |
|---|---|
| Strangers' code reaching the pool | Public repositories are never served (discovery skips them, even when they are in `include`). `decide` refuses fork pull requests and any event from a public repository, and the workflow template skips its jobs there. Keep "Run workflows from fork pull requests" off for private repositories. |
| A job leaving something behind for the next job | Every job gets a fresh just-in-time runner pod that runs one job and is deleted. No shared caches or volumes between jobs. |
| A job reaching the home network or the hypervisor | The VM sits on an isolated segment with outbound HTTPS and DNS only; traffic to private, CGNAT and link-local ranges and to the host is dropped. Jobs run inside a VM, not on the Proxmox host's kernel. No privileged pods, no Docker socket. |
| A job stealing the App key | The key exists in one Kubernetes secret in the runner namespace, read by the ARC controller and listeners, and in one file on the discovery host. Runner pods get no service account token. Discovery narrows its own token to `actions:read` and `metadata:read`. |
| A job obtaining other secrets | spillway passes no secrets to jobs. `GITHUB_TOKEN` is scoped to `contents: read`, `actions: read`, `statuses: write` and is not persisted by checkout (`persist-credentials: false`). |
| A failed job hidden by the fallback | `decide` reruns only when a failed job never started (no runner, no steps). A job that started and failed stays failed. |
| The pool exhausting the host | Runner pods request CPU and memory; pods that do not fit stay `Pending` and their jobs queue at GitHub. |

### Residual risks

- A container escape inside the VM reaches the node, where the controller's secret lives. Running the controller on a separate node from the runners narrows this; the single-node setup does not.
- Runner pods on the same node share its kernel. Jobs from different repositories can run side by side.
- A queued job waits at most 24 hours at GitHub before it is cancelled.
- spillway pins the ARC chart and runner image versions; you must update them.

### Making a served repository public

A runner scale set is registered on the repository itself. Discovery removes it within about five minutes of the repository turning public, but until then a pull request from a fork can change the CI workflow to `runs-on: spillway` and reach the pool: no workflow-side check helps, because the fork's own workflow files run. So remove the scale set **before** changing the visibility:

1. Add the repository to `exclude` (and drop it from `include`) in the discovery config, `/etc/spillway/config.json` in the VM, then run `bash deploy/pool.sh apply`. Its release should show as `uninstall`.
2. Check that the repository's Settings → Actions → Runners lists no `spillway` runner scale set.
3. Set Settings → Actions → General → "Approval for running fork pull request workflows from contributors" to require approval for all outside collaborators.
4. Change the visibility. Hosted runners are free for public repositories, so its CI no longer needs the pool.

## Hardening checklist

- [ ] The VM's segment cannot reach your LAN, the Proxmox host or cloud metadata addresses.
- [ ] The App is installed only on your account, has no webhook, and has exactly Administration (read and write), Actions (read) and Metadata (read).
- [ ] The private key file is `0600`, owned by root, and in no backup that leaves the machine unencrypted.
- [ ] Fork pull request workflows are disabled for the served repositories.
- [ ] Branch protection and merge rules state when `spillway / ci` may stand in for the hosted CI (templates/AGENTS.snippet.md).
