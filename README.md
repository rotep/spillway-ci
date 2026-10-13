# spillway

[![CI](https://github.com/rotep/spillway-ci/actions/workflows/ci.yml/badge.svg)](https://github.com/rotep/spillway-ci/actions/workflows/ci.yml) [![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

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
   decide  → was it a runner/billing failure? not a fork? still the head?
   ci      → your CI, called with runs-on: spillway, at the PR head
             (a newer head cancels it)
   report  → commit status "spillway / ci" on the PR head

home: Proxmox VM ─ k3s ─ Actions Runner Controller
        one scale set per repository, label "spillway"  ◄── discovery (systemd timer)
```

- [`actions/decide`](actions/decide) and [`actions/status`](actions/status): JavaScript actions with zero dependencies.
- [`discovery/`](discovery): GitHub App → opted-in private repositories → Helm releases of ARC's `gha-runner-scale-set`.
- [`templates/spillway.yml`](templates/spillway.yml): the per-repository workflow.

## Is it for you?

| You have | spillway fits | Something else fits better |
|---|---|---|
| Private repositories on a personal account, occasionally out of hosted minutes | yes | |
| Spare hardware at home with Proxmox VE | yes | |
| Public repositories only | | Hosted runners are free for public repositories |
| An organization that wants self-hosted runners as the primary CI | | [Actions Runner Controller](https://github.com/actions/actions-runner-controller) directly, with an organization-level scale set |
| Occasional overflow and no spare hardware | | Raising the Actions budget |
| Jobs that need Docker (`services:`, `container:`, `docker build`) | not yet | Hosted runners, or ARC in Docker-in-Docker mode |

Requirements:

- A Proxmox VE host that can give one VM 4 vCPU, 10 GiB of memory and 40 GB of disk (two concurrent jobs by default), with outbound HTTPS.
- A WSL or Linux shell with `ssh` to the host for the installer, or the host's web shell.
- A GitHub personal account and a GitHub App you create during installation (the installer does it from a manifest).
- In each adopted repository, a CI workflow that can be made callable ([docs/adopt.md](docs/adopt.md)) and needs no secrets.

Limitations: Linux jobs only, no Docker in jobs, one node by default, and the fallback result is a commit status (`spillway / ci`) that cannot satisfy a required hosted check in branch protection. More in [docs/adopt.md](docs/adopt.md#limits).

## Use it

1. Read [SECURITY.md](SECURITY.md). Pull request code runs on your machines. spillway serves **private repositories only**; never point it at a public one.
2. Deploy the pool with one command from a WSL or Linux shell (if it cannot `ssh` to the Proxmox host as root without a prompt, it prints one line to paste into the host's Shell in the Proxmox web UI instead):
   ```bash
   SPILLWAY_PVE_HOST=<ssh destination of your Proxmox host> SPILLWAY_INCLUDE="repo1 repo2" bash deploy/install-from-wsl.sh
   ```
   You confirm, press "Create GitHub App" in the browser and paste back the address it opens; when the host's output asks, install the App on all repositories. The App's key is created by GitHub and written only inside the VM. The manual steps behind the installer are in [docs/deploy-proxmox-k3s.md](docs/deploy-proxmox-k3s.md).
3. Adopt each repository: [docs/adopt.md](docs/adopt.md), or hand [templates/adopt-prompt.md](templates/adopt-prompt.md) to a coding agent, or run `/spillway:adopt` in Claude Code ([below](#with-claude-code)).
4. Operate it from the same shell: `bash deploy/pool.sh status | plan | apply | include add <repo> | update`, or `/spillway:pool` in Claude Code.
5. When something does not work: [docs/troubleshooting.md](docs/troubleshooting.md), or `/spillway:troubleshoot <pull request>` in Claude Code.
6. The whole path from nothing to steady state: [docs/roadmap.md](docs/roadmap.md).

## With Claude Code

The repository is also a Claude Code plugin with three skills. Install it in Claude Code on your machine:

```text
/plugin marketplace add rotep/spillway-ci
/plugin install spillway@spillway
```

If the repository is private, Claude Code clones it with your git credentials: if `git clone` works in your shell, this works too. When you enable the plugin, Claude Code asks for the values `deploy/pool.sh` reads (`SPILLWAY_PVE_HOST`, `SPILLWAY_SSH`, `SPILLWAY_NET`) and the path of your spillway clone; leave one empty for its default. `claude plugin configure spillway@spillway` shows them later.

| Skill | What it does | Started by |
|---|---|---|
| `/spillway:adopt [CI workflow]` | Adopts the current repository as in [templates/adopt-prompt.md](templates/adopt-prompt.md), pinning the actions to the current commit of `main`. | you or Claude |
| `/spillway:pool <command>` | Runs `deploy/pool.sh`. `status`, `plan` and `include list` run at once; `apply`, `include add`, `include remove` and `update` only after you confirm the exact command. | you only |
| `/spillway:troubleshoot [pull request]` | Reads `spillway / ci`, the hosted jobs and the `spillway` runs, and matches them to [docs/troubleshooting.md](docs/troubleshooting.md). It asks you for the pool side. | you or Claude |

The skills read this repository's docs and templates, so they change with it. The rule that lets agents merge on `spillway / ci` stays in each adopted repository ([templates/AGENTS.snippet.md](templates/AGENTS.snippet.md)), not in the plugin. Claude Code on the web does not load plugins: there, hand [templates/adopt-prompt.md](templates/adopt-prompt.md) to the session as before.

## Fork it

The deploy scripts, docs, templates and skills name `rotep/spillway-ci` and defaults such as the bridge `vmbr98` and network `10.98.0.0/24`. Fork the repository, replace `rotep/spillway-ci` in `templates/`, `docs/`, `skills/`, `.claude-plugin/` and this file, and set the `SPILLWAY_*` variables listed in the headers of `deploy/*.sh` for your host.

## Develop

```bash
npm test   # node --test; Node 22 or later, no dependencies
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Design and alternatives considered: [docs/design.md](docs/design.md).

## Support

Best effort, by one maintainer. Bugs and proposals go to issues; vulnerabilities go to private vulnerability reporting ([SECURITY.md](SECURITY.md)).

## License

[Apache-2.0](LICENSE)
