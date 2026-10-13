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

## Runner pods stay `Pending`

The pool is full. Each runner pod requests the CPU and memory in the config's `defaults` (1.5 CPU and 3 GiB unless overridden), and pods that do not fit wait while their jobs queue at GitHub. Wait, keep `maxRunners` within what the VM fits, give a repository its own `cpu`/`memory` in `repos`, or add a node ([docs/deploy-proxmox-k3s.md](deploy-proxmox-k3s.md#8-grow)).

## A job passes on hosted runners but fails on the pool

- **A missing tool.** The pool's runner image is minimal. Install what the job needs only on the pool: `if: inputs.ref` is true only when spillway calls the CI.
- **`services:` or `container:`.** These need Docker, which the default pool does not provide. Leave such jobs out of the callable path.
- **A secret.** spillway passes no secrets to the pool. Jobs that need one should stay hosted-only.
- **A changed CI workflow.** On `workflow_run`, GitHub runs the default branch's copy of `spillway.yml` and of the called CI, so a pull request that edits the CI is checked with the old definition. Use the `spillway` label to run the pull request's own copy.

## Jobs stop being picked up after a while

GitHub stops routing jobs to runners that are too old. Bump `runnerImage` in the config to a current [actions/runner](https://github.com/actions/runner/releases) release; discovery upgrades every scale set on its next run.

## `uses: <owner>/spillway/actions/...` fails with "not found"

The repository hosting the actions is private and has not allowed access: its Settings → Actions → General → Access → "Accessible from repositories owned by the user". Also check that the pinned tag or SHA exists there.
