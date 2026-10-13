# spillway

Overflow GitHub Actions CI to your own hardware when GitHub-hosted minutes run out.

> Status: early (October 2026). One personal account has run its private repositories' CI on a single-node pool since 2026-10-12. There is no release yet; pin a commit SHA. Interfaces may change.

GitHub-hosted runners stay your primary CI. When their jobs never start, because the account's included minutes or Actions budget ran out or no runner was acquired, spillway reruns the same CI on an autoscaling pool of ephemeral runners at home and reports the result on the pull request as the commit status `spillway / ci`. Jobs that started and failed are never papered over.

It is built for a **personal GitHub account with many private repositories**:

- **Every repository, including new ones.** A personal account cannot have account-wide runners. spillway's discovery keeps one runner scale set per repository and adds a repository as soon as it merges the spillway workflow.
- **No inbound ports.** Runner scale sets long-poll GitHub; nothing at home listens.
- **One job per runner.** Each job gets a fresh just-in-time runner that is deleted afterwards.
- **Queues instead of crashing.** The pool's size is set by CPU and memory requests; extra jobs wait at GitHub.
- **Agent-friendly.** A ready-made merge rule for `AGENTS.md`/`CLAUDE.md` tells coding agents exactly when the fallback result may stand in for the hosted CI.

No existing tool we found does hosted-to-self-hosted overflow; the selection actions that exist go the other way. See [docs/design.md](docs/design.md#prior-art).

## How it works

```
hosted CI fails without starting ─► spillway.yml (in your repository)
   decide  → was it a runner/billing failure? not a fork?
   ci      → your CI, called with runs-on: spillway, at the PR head
   report  → commit status "spillway / ci" on the PR head

home: Proxmox VM ─ k3s ─ Actions Runner Controller
        one scale set per repository, label "spillway"  ◄── discovery (systemd timer)
```

- [`actions/decide`](actions/decide) and [`actions/status`](actions/status): JavaScript actions with zero dependencies.
- [`discovery/`](discovery): GitHub App → opted-in private repositories → Helm releases of ARC's `gha-runner-scale-set`.
- [`templates/spillway.yml`](templates/spillway.yml): the per-repository workflow.

## Use it

1. Read [SECURITY.md](SECURITY.md). Pull request code runs on your machines. spillway serves **private repositories only**; never point it at a public one.
2. Deploy the pool with one command from a WSL or Linux shell (if it cannot `ssh` to the Proxmox host as root without a prompt, it prints one line to paste into the host's Shell in the Proxmox web UI instead):
   ```bash
   SPILLWAY_PVE_HOST=<ssh destination of your Proxmox host> SPILLWAY_INCLUDE="repo1 repo2" bash deploy/install-from-wsl.sh
   ```
   You confirm, press "Create GitHub App" in the browser and paste back the address it opens; when the host's output asks, install the App on all repositories. The App's key is created by GitHub and written only inside the VM. The manual steps behind the installer are in [docs/deploy-proxmox-k3s.md](docs/deploy-proxmox-k3s.md).
3. Adopt each repository: [docs/adopt.md](docs/adopt.md), or hand [templates/adopt-prompt.md](templates/adopt-prompt.md) to a coding agent.
4. Operate it from the same shell: `bash deploy/pool.sh status | plan | apply | include add <repo> | update`.
5. The whole path from nothing to steady state: [docs/roadmap.md](docs/roadmap.md).

## Fork it

The deploy scripts, docs and templates name `rotep/spillway-ci` and defaults such as the bridge `vmbr98` and network `10.98.0.0/24`. Fork the repository, replace `rotep/spillway-ci` in `templates/` and `docs/`, and set the `SPILLWAY_*` variables listed in the headers of `deploy/*.sh` for your host.

## Develop

```bash
npm test   # node --test; Node 22 or later, no dependencies
```

## License

[Apache-2.0](LICENSE)
