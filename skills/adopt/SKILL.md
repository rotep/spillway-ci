---
name: adopt
description: Adopt spillway in the current repository so that its CI overflows to the owner's self-hosted pool when GitHub-hosted jobs never start (minutes or budget ran out). Makes the CI workflow callable, adds .github/workflows/spillway.yml pinned to a spillway commit, and adds the merge rule for agents. Use when asked to adopt spillway, add the spillway fallback, or let this repository's CI run on the home pool.
argument-hint: "[CI workflow name]"
---

# Adopt spillway in this repository

The steps are the ones in `${CLAUDE_PLUGIN_ROOT}/templates/adopt-prompt.md` (the text block), which people paste into sessions that have no plugin. Read that file and `${CLAUDE_PLUGIN_ROOT}/docs/adopt.md` first, then carry the steps out here with the differences below. This repository's own `CLAUDE.md`/`AGENTS.md` rules (branching, commit style, merge rules, stop conditions) still apply and win over this skill where they are stricter.

If the user named the CI workflow, use it: $ARGUMENTS

## Before step 1

- Check that this repository is **private** (`gh repo view --json visibility`, or the GitHub tools). If it is public, stop and say so: spillway never serves a public repository, and hosted runners are free for public repositories.
- If the repository already has `.github/workflows/spillway.yml`, compare it with the template instead of copying again, and only bring it up to date.

## Differences from the prompt

- **Which files.** Where the prompt names a file of `rotep/spillway-ci`, do not attach that repository. Read the files at the commit you pin (next point), not the copies under `${CLAUDE_PLUGIN_ROOT}`: the plugin's copy may be older, and the workflow template must match the actions it pins.
- **The pin.** Pin `rotep/spillway-ci/actions/decide` and `rotep/spillway-ci/actions/status` to the full 40-character SHA of `rotep/spillway-ci`'s current `main`. Read it with `gh api repos/rotep/spillway-ci/commits/main --jq .sha` (or `git ls-remote https://github.com/rotep/spillway-ci refs/heads/main`), and read the template and the snippet at that SHA, for example `gh api 'repos/rotep/spillway-ci/contents/templates/spillway.yml?ref=<sha>' --jq .content | base64 -d`. Never pin a branch name or `@v0` unless such a tag exists.
- **The template stays as it is.** Change only `workflows:` (the CI workflow's `name:`) and the two `uses:` pins. Do not add secrets, widen `permissions:`, change the triggers or the job conditions: this code runs on the owner's machines.
- **The include list.** Until the workflow reaches the default branch, discovery does not serve the repository, so the label path's `decide` job queues. Before adding the label, tell the user to run `/spillway:pool include add <this repository's name>` (or `bash deploy/pool.sh include add <name>` in their spillway clone), and after the merge `/spillway:pool include remove <name>`. Do not run them yourself: they change the pool.
- **While `rotep/spillway-ci` is private**, the target repository can use its actions only after the owner allows it: `rotep/spillway-ci` → Settings → Actions → General → Access → "Accessible from repositories owned by the user". If `uses:` fails with "not found", that is the cause; tell the user.

## Done when

The pull request is open with the label `spillway`, and either the hosted CI ran normally, or `spillway / ci` reached `success` on the head SHA. Merge only under this repository's merge rule plus the spillway exception from `templates/AGENTS.snippet.md` (every failed hosted job never started, and `spillway / ci` is `success` on the same head SHA), and say in the pull request that you substituted. If `spillway / ci` stays `pending` for 30 minutes, stop and tell the user (`/spillway:troubleshoot` helps find why).

Report in the language this repository's rules ask for.
