# Troubleshooting

Start with `bash deploy/pool.sh status` (scale sets, runner pods, the discovery timer and its last log) and `bash deploy/pool.sh plan` (what discovery would change).

## The `spillway` workflow stays queued

Its `decide` job runs on the pool (`runs-on: spillway`), so it waits until the repository has a runner scale set.

- `bash deploy/pool.sh plan` should list the repository. If it does not, check that the repository is **private**, not archived, not in `exclude`, and has `.github/workflows/spillway.yml` on its default branch. Discovery picks it up within one timer period (5 minutes); `bash deploy/pool.sh apply` does it now, and `include add <repo>` serves a repository before its workflow lands.
- The repository's Settings → Actions → Runners should show `spillway-<repository>` with the label `spillway`.
- If the scale set exists but no runner pod appears, the VM or the ARC listener is down: check `status` for the listener pod and that the VM is running.

A queued job waits at most 24 hours at GitHub before it is cancelled.

## The workflow ran, but `spillway / ci` never appeared

`decide` chose not to run. Its log states why:

| Reason in the log | Meaning |
|---|---|
| `Every failed job started; this is the code's failure, not a runner problem.` | The hosted CI really failed. Fix the code; spillway does not cover started jobs. |
| `The run ended "…"; only failures are checked.` | The hosted CI did not fail (for example it was cancelled). |
| `The pull request comes from a fork …` / `The run comes from a fork …` | Fork code never runs on the pool. |
| `The repository is public …` | Public repositories are never served. |
| `The pull request does not carry the label spillway.` | The manual path needs the `spillway` label on the pull request. |
| `… is no longer the head of <branch> …` / `The branch … no longer exists …` | The pull request moved on (or was merged and its branch deleted) before `decide` ran. The newer head gets its own run; the older one is not worth the pool. |

## `spillway / ci` is `error`

- **`spillway could not decide: …`**: `decide` could not reach the GitHub API, even after retrying for about 15 seconds. Re-run the failed jobs of the `spillway` run, or add the label `spillway` to the pull request.
- **`CI on the self-hosted pool cancelled`**: a newer head of the same branch started its own CI on the pool and cancelled this one, or someone cancelled the run on an older head. Look at the status on the pull request's current head instead.

A run cancelled while its commit is still the branch's head posts nothing, because the run that cancelled it (on the same commit) reports. If a person cancelled it, `spillway / ci` stays `pending`; re-run the `spillway` workflow or add the label `spillway`.

## Runner pods stay `Pending`

The pool is full. Each runner pod requests the CPU and memory in the config's `defaults` (1.5 CPU and 3 GiB unless overridden), and pods that do not fit wait while their jobs queue at GitHub. Wait, keep `maxRunners` within what the VM fits, give a repository its own `cpu`/`memory` in `repos`, or add a node ([docs/deploy-proxmox-k3s.md](deploy-proxmox-k3s.md#8-grow)).

One repository can hold every runner. A scale set runs up to `maxRunners` pods (2 by default) and the default VM fits two, so two long jobs from one repository leave none for the others until they end. Let the VM fit more pods than any one repository's `maxRunners`: lower `cpu` in `defaults` (it is a request with no CPU limit, so a job alone on the VM still uses every idle core), or lower that repository's `maxRunners` in `repos`. In the VM, `kubectl describe node` (Allocated resources) shows what is already reserved.

## A job fails with "The self-hosted runner lost communication with the server"

Most often the job ran out of memory. A runner pod's memory limit equals its `memory` (3 GiB unless overridden). When the job's processes go over it, the kernel kills every process in the runner container, the runner included (the container's cgroup sets `memory.oom.group`). The job's log stops mid-step, and about 10 minutes later GitHub fails the job with this message. The pod's CPU and memory are free again as soon as it dies. Parallel compilers (`cargo`, `rustc`, bundlers) are the usual cause.

- Confirm in the VM: `sudo journalctl -k | grep -i 'memory cgroup out of memory'` lists the killed processes at the time the log stopped.
- Give that repository more `memory` in `repos`, within what the VM fits (the value is reserved for each of its runners), or lower the build's parallelism when spillway runs it (`if: inputs.ref`), for example with `CARGO_BUILD_JOBS`.
- If the kernel log shows nothing, the VM may have stopped or lost its network: check `bash deploy/pool.sh status`.

## A job passes on hosted runners but fails on the pool

- **A missing tool.** The pool's runner image is minimal. Install what the job needs only on the pool: `if: inputs.ref` is true only when spillway calls the CI.
- **`services:` or `container:`.** These need Docker, which the default pool does not provide. Leave such jobs out of the callable path.
- **A secret.** spillway passes no secrets to the pool. Jobs that need one should stay hosted-only.
- **A changed CI workflow.** On `workflow_run`, GitHub runs the default branch's copy of `spillway.yml` and of the called CI, so a pull request that edits the CI is checked with the old definition. Use the `spillway` label to run the pull request's own copy.

## Jobs stop being picked up after a while

GitHub stops routing jobs to runners that are too old. Bump `runnerImage` in the config to a current [actions/runner](https://github.com/actions/runner/releases) release; discovery upgrades every scale set on its next run.

## `uses: <owner>/spillway/actions/...` fails with "not found"

The repository hosting the actions is private and has not allowed access: its Settings → Actions → General → Access → "Accessible from repositories owned by the user". Also check that the pinned tag or SHA exists there.
