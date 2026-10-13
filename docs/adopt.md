# Adopting spillway in a repository

Four steps. After the workflow lands on the default branch, discovery registers a runner scale set for the repository within one timer period (5 minutes by default).

Only **private** repositories are served. Discovery skips public ones even if they carry the workflow: anyone can open a pull request on a public repository, and GitHub advises against self-hosted runners there. Public repositories get GitHub-hosted runners for free anyway.

## 1. Make the CI workflow callable

Add a `workflow_call` trigger with two inputs, and use them in every job. On `push` and `pull_request` the inputs are empty, so the jobs keep running on GitHub-hosted runners as before.

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
  workflow_call:
    inputs:
      runs-on:
        description: runs-on as JSON, for example '"spillway"'.
        type: string
        default: '"ubuntu-latest"'
      ref:
        description: Commit to check out. Empty means the event's default.
        type: string
        default: ''

jobs:
  test:
    runs-on: ${{ fromJSON(inputs.runs-on || '"ubuntu-latest"') }}
    steps:
      - uses: actions/checkout@v7
        with:
          ref: ${{ inputs.ref }}
          persist-credentials: false
      # ... your steps, unchanged
```

Keep the CI free of secrets. If a job needs one, leave that job out of the callable path rather than passing secrets to the pool.

## 2. Add the spillway workflow

Copy [`templates/spillway.yml`](../templates/spillway.yml) to `.github/workflows/spillway.yml` and set `workflows: [CI]` to your CI workflow's `name:`. Pin `rotep/spillway-ci/actions/*` to a release tag or a commit SHA.

The workflow:

- runs when a CI run fails, and reruns the CI on the pool only when a failed job **never started** (no runner, no steps). A job that started and failed is left alone;
- runs when a pull request carries the label `spillway` (create the label once; people and agents add it to ask for a run);
- never runs code from forks;
- runs only a branch's current head, and cancels an older head's CI on the pool when a newer head starts;
- posts `spillway / ci` (pending, then success or failure) on the pull request's head commit.

## 3. Tell people and agents the merge rule

Paste [`templates/AGENTS.snippet.md`](../templates/AGENTS.snippet.md) into `AGENTS.md` or `CLAUDE.md`. GitHub's required status checks cannot express "hosted green **or** fallback green", so the rule is written down instead. If the repository requires the hosted checks in branch protection, a fallback result cannot satisfy them; decide whether to keep that protection.

## 4. While the spillway repository is private

A private repository's actions are usable from other private repositories of the same owner only after the owner allows it: spillway → Settings → Actions → General → Access → "Accessible from repositories owned by the user". This step goes away once spillway is public.

## Tips from real adoptions

- The pool's runner image is minimal. If a job needs a browser or another tool that hosted images ship, install it only on the pool: `if: inputs.ref` is true only when spillway calls the CI.
- If branch protection requires the hosted check, a green `spillway / ci` cannot satisfy it. Decide in advance whether the owner may merge with admin rights in that case.

## Limits

- On `workflow_run`, GitHub runs the default branch's copy of `spillway.yml` and of the called CI workflow. A pull request that changes the CI workflow is checked on the pool with the default branch's CI definition (its own code, though). The label path uses the pull request's own copy.
- The fallback result is a commit status, not a check run, so it appears under the pull request's checks as `spillway / ci` but does not replace the red hosted check.
- Jobs that use `services:` or `container:` need Docker, which the default pool does not provide.
