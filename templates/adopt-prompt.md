# Prompt: adopt spillway in a repository

Start a coding-agent session on the target repository with `rotep/spillway-ci` attached as a second repository (it is private until published), and paste the block below. Replace nothing: the session finds the names itself.

```text
Adopt spillway (rotep/spillway-ci) in this repository so that its CI overflows to the owner's self-hosted pool when GitHub-hosted jobs never start. Follow rotep/spillway-ci docs/adopt.md exactly and this repository's own CLAUDE.md/AGENTS.md rules (branching, commit style, merge rules, stop conditions).

1. Read this repository's CI workflow(s). Pick the workflow whose jobs gate merges. If a job needs secrets, services: or container:, leave that job out of the callable path and say so in the PR.
2. Make that workflow callable: add `workflow_call` with inputs `runs-on` (string, default '"ubuntu-latest"') and `ref` (string, default ''); use `runs-on: ${{ fromJSON(inputs.runs-on || '"ubuntu-latest"') }}` and pass `ref: ${{ inputs.ref }}` plus `persist-credentials: false` to checkout. Behaviour on push and pull_request must not change. Update any test in this repository that mirrors the CI file.
3. Copy rotep/spillway-ci templates/spillway.yml to .github/workflows/spillway.yml. Set `workflows:` to the CI workflow's `name:`. Pin rotep/spillway-ci/actions/* to the commit SHA of rotep/spillway-ci main you read. Do not add secrets, widen permissions or change triggers.
4. Add the section from templates/AGENTS.snippet.md to CLAUDE.md (or AGENTS.md if that is the file agents read). If this repository's merge rule lives elsewhere, add the spillway exception there too, quoting the conditions word for word.
5. Run this repository's local checks. Open the PR (draft while incomplete). Add the label `spillway` to the PR.
6. If hosted CI runs normally, it is the gate as before. If hosted jobs fail without starting (no runner, no steps), wait for `spillway / ci` on the PR head. If it stays pending for 30 minutes, tell the owner that the pool may be down or that this repository is not yet in the pool's include list.
7. Merge only under this repository's merge rule plus the spillway exception (every failed hosted job never started, and `spillway / ci` is success on the same head SHA). State in the PR that you substituted. If this repository has no written merge rule, ask the owner instead of merging.

Report in the language this repository's rules ask for.
```
