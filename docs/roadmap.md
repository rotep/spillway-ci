# Roadmap: from nothing to self-driving overflow

The goal is a state where nobody has to act when GitHub-hosted minutes run out: pull requests in every private repository keep getting a CI result from the home pool, new repositories join by merging one workflow, and agents know when the fallback result counts.

Owner actions are single pastes. Everything else is done by coding-agent sessions or by the pool itself.

Status (2026-10-12, the author's own setup): phases 1 and 2 done for three repositories; the automatic path ran on a real exhaustion (hosted jobs never started, `spillway / ci` success on `main`).

## Phase 1. Pool up (owner, one paste)

From a WSL shell with a clone of spillway:

```bash
SPILLWAY_PVE_HOST=pve-01 SPILLWAY_INCLUDE="repo1 repo2" bash deploy/install-from-wsl.sh
```

The installer asks for a confirmation and for the address GitHub opens after "Create GitHub App". Near the end the host's output asks you to install the App on all repositories (GitHub registers a manifest App only when the code is exchanged inside the VM). Then it builds the isolated bridge and the VM, installs k3s, Actions Runner Controller and discovery, and registers a scale set for each repository in `SPILLWAY_INCLUDE` (and for every private repository that already has the spillway workflow).

Done when: the installer ends with a list of `autoscalingrunnersets`, and each listed repository shows its runner scale set (`spillway-<repository>`, label `spillway`) under Settings → Actions → Runners.

## Phase 2. Adopt repositories (sessions)

For each repository, a session follows [`templates/adopt-prompt.md`](../templates/adopt-prompt.md). The pull request makes the CI callable, adds `.github/workflows/spillway.yml` and the merge rule. While hosted minutes are exhausted the session checks its own pull request through the label path (the repository must be in `include` until the workflow reaches the default branch):

1. Open the pull request; add the label `spillway`.
2. `spillway / ci` turns green on the head commit.
3. Merge under the rule in `templates/AGENTS.snippet.md` (hosted jobs never started, fallback green on the same head).

Done when: the workflow is on the default branch. From then on discovery keeps the scale set without `include`; empty the list with `bash deploy/pool.sh include remove <repo>`.

Lessons from the first three repositories:

- The pool's runner image is minimal. Jobs that need a browser or other tools install them in the callable path only (`if: inputs.ref` is true only when spillway calls the CI).
- Branch protection that requires the hosted check blocks the merge even when `spillway / ci` is green. One way the owner used: turn off "include administrators" for seconds, merge with admin rights, turn it back on.
- Jobs that use `services:` (for example a database) cannot run on the default pool.

## Phase 3. Steady state (automatic)

- Hosted CI fails without starting → `spillway` reruns the CI on the pool → `spillway / ci` on the pull request.
- A new private repository joins when its spillway workflow lands; nothing to configure at home.
- Bursts queue: runner pods that do not fit wait as `Pending`; their jobs wait at GitHub for up to 24 hours. `spillway-high` repositories start first.
- Sessions treat a `spillway / ci` that stays `pending`, or jobs that stay `queued`, as "pool down or full" and tell the owner.

## Phase 4. Absorb the old persistent runners

One repository at a time, after its spillway path has passed on a real pull request: switch its jobs from the old runner's labels to the spillway path, then the owner stops the old runner. Repositories with special needs (kernel features, nested virtualization) are checked by their own sessions first.

## Phase 5. Publish

- [ ] The pool has handled at least one real exhaustion cycle.
- [ ] No owner-specific values (host names, addresses, accounts) in the tree or history beyond the documented defaults.
- [ ] Secret scanning and push protection enabled; `SECURITY.md` reviewed.
- [ ] `rotep/spillway-ci/actions/*@v0` tagged; templates point at the tag.
- [ ] The owner flips the repository to public.

## Branch points (always the owner's call)

Real infrastructure (hosts, networks, VMs), GitHub App creation and installation, keys and secrets, billing, repository visibility, and changes to another repository's merge rules before that repository's own rules allow them.
