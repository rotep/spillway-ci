# Design

Status: in use since 2026-10-12 on a single-node pool serving one personal account's private repositories.

## Problem

A solo developer runs CI for many private repositories on GitHub-hosted runners. When the account's included minutes or Actions budget run out, every hosted job fails within seconds without a runner, and pull requests across all repositories stop merging until the next billing cycle. The developer owns spare home hardware (Proxmox hosts) and wants CI to overflow to it automatically, for every repository, including ones created later, without opening any inbound port at home.

GitHub has no first-party fallback between runner types; a community request for `fallback-runs-on` was answered in 2024 with "no plans". Existing actions only go the other way (self-hosted first, hosted when the self-hosted runners are offline). See [Prior art](#prior-art).

## Constraints

- **Personal account.** Self-hosted runners attach to a repository, an organization or an enterprise. A personal account has no account-wide runners, so every repository needs its own registration.
- **No inbound traffic.** The pool connects out to GitHub only.
- **Hosted first.** GitHub-hosted runners stay the primary CI; the pool covers outages and exhausted minutes.
- **Untrusted-ish code at home.** Pull request code runs on the owner's machines. Only private repositories are served, forks never run, and each job gets a fresh runner.
- **Small hardware.** A few concurrent jobs at most. Excess work must queue, not crash the host.

## Architecture

```
GitHub (hosted CI fails: jobs never started)
  └─ workflow_run ─► spillway.yml in the repository
        decide   (pool)  : did a failed job never start? fork? → post "spillway / ci: pending"
        ci       (pool)  : the repository's own CI, called with runs-on "spillway", at the head SHA
        report   (pool)  : post "spillway / ci: success|failure" on the head SHA

Home (outbound HTTPS only)
  VM on Proxmox ─ k3s ─ ARC controller
                        └─ one runner scale set per repository (spillway-<repo>), all labelled "spillway"
                              listener long-polls GitHub; each job gets a fresh JIT runner pod
  discovery (systemd timer, every 5 min)
        GitHub App installation → private repos with an active spillway.yml
        → helm install/upgrade/uninstall one scale set per repository
```

### 1. Router (per repository)

A short workflow (`templates/spillway.yml`) and two JavaScript actions with no dependencies:

- `actions/decide` reads the failed run's jobs. It runs the pool only if some failed job has no runner and no steps, which is how a job looks when minutes or budget are exhausted or no runner was acquired. A job that started and failed is the code's failure and is not covered. The `spillway` label is the manual entry point. Fork code is refused in both paths.
- `actions/status` posts the commit status `spillway / ci` on the head SHA. A `workflow_run`'s own checks attach to the default branch, so a status is the way to put the result on the pull request.

The router calls the repository's own CI as a reusable workflow with a `runs-on` input, so there is no copy of the CI to keep in sync. Composite or JavaScript actions are used instead of a shared reusable workflow from the spillway repository, because a reusable workflow owned by someone else cannot use the caller's self-hosted runners.

### 2. Discovery (new)

`discovery/main.mjs` runs on a timer next to the cluster. It authenticates as a GitHub App, asks for an installation token narrowed to `actions:read` and `metadata:read`, lists the installation's repositories, and keeps those that belong to the owner, are private, are not archived or excluded, and have `.github/workflows/spillway.yml` active. For each it renders Helm values for ARC's `gha-runner-scale-set` chart and installs, upgrades or keeps the release; releases with the spillway prefix whose repository dropped out are uninstalled. It never touches other releases. Without `--apply` it only prints the plan.

Opting in is merging the workflow file. No list to maintain, and a new repository joins by itself.

### 3. Executor: ARC on k3s

[Actions Runner Controller](https://github.com/actions/actions-runner-controller) runner scale sets are GitHub's official autoscaler. The listener long-polls GitHub, so no webhook or inbound port is needed. Each job gets an ephemeral runner registered with a just-in-time config, which runs one job and is removed.

- One k3s node in a VM on Proxmox to start; more nodes join later.
- Runner pods request CPU and memory. The scheduler is the global cap: a pod that does not fit waits as `Pending` and its job waits in GitHub's queue. PriorityClasses with `preemptionPolicy: Never` let chosen repositories go first without evicting running jobs.
- Jobs run in the default container mode (no Docker, no privileged pods). The VM's kernel, not the Proxmox host's, sits under the jobs.

## Security

See [SECURITY.md](../SECURITY.md) for the threat model. In short: private repositories only, no forks, one fresh runner per job, an isolated network segment with outbound HTTPS and DNS only, no secrets passed to jobs, the App key only in the controller's namespace and the discovery host, and workflow permissions limited to `contents: read`, `actions: read`, `statuses: write`.

## Alternatives considered

| Option | Why not (for now) |
|---|---|
| Persistent runner per repository (one LXC each) | No automatic onboarding, no autoscaling, state leaks between jobs. This is what the owner ran before. |
| Proxmox-native controllers that clone an LXC or VM per job ([pve-runners](https://github.com/ServerTooling/Proxmox-github-runners), [actions-runner-scaleset-proxmox](https://github.com/JeffResc/actions-runner-scaleset-proxmox), [ghrm](https://github.com/cocardoso/gh-runners-manager), [proxmox-actions-runners](https://github.com/klponce/proxmox-actions-runners)) | Promising, but days to weeks old in October 2026. LXC-per-job runs jobs on the Proxmox host's kernel. Could become a second executor later. |
| [GARM](https://github.com/cloudbase/garm) with Incus | Mature, scale sets since v0.2.0 (long-poll), but no Proxmox provider; adds Incus. |
| [runscaler](https://github.com/ysya/runscaler) (Docker) | PAT only; mounts the Docker socket into runners by default. |
| Own executor on [actions/scaleset](https://github.com/actions/scaleset) | Most work; the library is in public preview. |
| Cloudflare Containers | Not a runner: each repository needs its own pipeline. Per-minute cost lower than hosted runners, plus a fixed fee. |
| Raising the GitHub budget | Simplest, linear cost. Still the right answer for occasional overflow. |

## Prior art

- Hosted ↔ self-hosted selection actions (all self-hosted first, hosted as fallback): [jimmygchen/runner-fallback-action](https://github.com/jimmygchen/runner-fallback-action) (archived), [mikehardy fork](https://github.com/mikehardy/runner-fallback-action), [Self-Hosted Runner Fallback](https://github.com/marketplace/actions/self-hosted-runner-fallback).
- Projects that route to self-hosted runners: [dashpay/dash#7854](https://github.com/dashpay/dash/pull/7854) routes there when hosted jobs queue; [resq-software/.github#38](https://github.com/resq-software/.github/pull/38) adds a `runner` input toggled by a variable after hosted minutes ran out.
- [GitHub community discussion #20019](https://github.com/orgs/community/discussions/20019): `fallback-runs-on` request.
- GitHub docs: [autoscaling with ephemeral runners](https://docs.github.com/en/actions/hosting-your-own-runners/managing-self-hosted-runners/autoscaling-with-self-hosted-runners), [secure use](https://docs.github.com/en/actions/reference/security/secure-use), [JIT runners](https://github.blog/changelog/2023-06-02-github-actions-just-in-time-self-hosted-runners/).

## Open questions

1. ~~Do self-hosted jobs keep running while the account's hosted minutes are exhausted?~~ Yes: on 2026-10-12, with the included minutes used up, hosted jobs failed without a runner and the pool ran the same CI to success.
2. ~~ARC with a GitHub App owned by a personal account and repository-scoped scale sets?~~ Works, including a shared scale set label for `runs-on` (ARC 0.14.2). Scale set names must differ within a namespace, because ARC derives resource names from them.
3. Runner image updates: GitHub stops routing jobs to runners that are too old. Bump `runnerImage` when actions/runner releases.
4. A proactive mode (switch to the pool before failures, using the billing usage API with a user token) is out of scope until the reactive mode has run for a cycle.
