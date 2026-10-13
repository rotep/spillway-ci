# CLAUDE.md — spillway

Working rules for coding agents (Claude Code, local or cloud) in this repository. What spillway is: [README.md](README.md); why it is built this way: [docs/design.md](docs/design.md); the plan: [docs/roadmap.md](docs/roadmap.md). The decision records (ADR-0019, ADR-0012) are in the owner's private repositories.

## Language

Code, comments, docs and commit messages in English (the repository is meant to be published). Reports to the owner in Japanese, conclusion first, facts and inferences kept apart.

## Work

- Never push to `main` directly: branch (`feat/…`, `fix/…`, `docs/…`, `ci/…`; cloud sessions may use `claude/…`), pull request, squash merge. While bootstrapping (2026-10-12), before any CI could run, the owner pushed the first commits to `main` directly; the pool has been running since that day, so that has ended.
- Before pushing: `npm test` (Node 22 or later, no dependencies) and `bash -n deploy/*.sh`. CI also runs `shellcheck deploy/*.sh`. After changing `.claude-plugin/` or `skills/`, also `claude plugin validate .` (the warnings about the missing version and `CLAUDE.md` are expected).
- Keep zero runtime dependencies. Adding a package is a branch point.
- No secrets, host names, addresses or account names in files, commits or pull requests beyond the documented generic defaults. Test values that look like keys are built at runtime.
- Write as if the repository were public, because it is meant to be: commit messages, pull request bodies and comments do not name the owner's private repositories, hosts, VM IDs, App or installation IDs, or run IDs. Owner-specific records belong in the owner's private repositories.

## Merge rule (owner's decision, 2026-10-12)

The owner gave this repository the merge authority of ADR-0012. Any session may squash-merge a pull request without asking when all hold:

- every CI job on the head is green (or, while the owner's hosted minutes are exhausted, spillway's own exception below applies);
- it is not a draft, has no unresolved review and no reservation in its body ("do not merge", "WIP");
- it contains no branch point (below).

Re-read the head SHA, the CI result and mergeability right before merging, and merge with that head (`expectedHeadSha`, or `gh pr merge --squash --match-head-commit <sha>`). Write the squash subject and body yourself.

While this repository is private, it adopts itself: `.github/workflows/spillway.yml` reruns the CI on the owner's pool when hosted jobs never start, and the rule in `templates/AGENTS.snippet.md` applies here too (substitute `spillway / ci` = success only when every failed hosted job never started, on the same head SHA, and say so in the pull request). Once the repository is public, discovery stops serving it, `decide` and the workflow's job condition refuse public repositories, and hosted runners are free, so the exception lapses by itself. Before the visibility changes, the owner removes this repository's scale set as `SECURITY.md` ("Making a served repository public") describes. Keep `.github/workflows/spillway.yml` equal to the template except for the pinned actions (a test checks it).

## Branch points (the owner merges or decides)

- `deploy/` (it runs as root on the owner's Proxmox hosts), the App manifest and permissions (`discovery/manifest.mjs`), and anything that changes what runs on the owner's machines or with which credentials. Running `deploy/pool.sh` or the installer is the owner's job; sessions hand over the exact command.
- Weakening the guard rails: `templates/spillway.yml` permissions or triggers, the fork and public-repository refusals, `SECURITY.md`'s controls.
- Repository visibility, releases that adopting repositories pin, new dependencies. This repository stays private, so the SHAs adopters pin keep resolving; the public copy is a separate repository without this history, filled by `scripts/export-public.sh`, which the owner runs and pushes.
- Real infrastructure, keys and secrets, billing: never done by a session.
