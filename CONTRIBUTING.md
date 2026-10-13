# Contributing

spillway is a small project maintained on a best-effort basis. Issues and pull requests are welcome; answers may take a while.

## Before you open something

- **Security problems:** do not open an issue. Use private vulnerability reporting (Security → Report a vulnerability), as [SECURITY.md](SECURITY.md) says.
- **Questions about your own deployment:** read [docs/troubleshooting.md](docs/troubleshooting.md) first. Include `bash deploy/pool.sh status` output with names and addresses removed.
- **Larger changes:** open an issue to agree on the approach before writing code.

## Ground rules

- **Zero runtime dependencies.** The actions and discovery use only Node.js 22+ built-ins. A pull request that adds a package needs a strong reason.
- **No secrets, host names or addresses** in code, tests, commits or pull requests. Test values that look like keys are built at runtime.
- **Guard rails stay.** Changes that weaken the fork and public-repository refusals, the workflow template's permissions or triggers, or the controls in [SECURITY.md](SECURITY.md) are not accepted without a matching design discussion.
- **`deploy/` runs as root** on the operator's hypervisor. Keep it idempotent, `set -euo pipefail`, and shellcheck-clean; say in the pull request how you tested it.
- **Documentation follows behavior.** If a change alters what an operator or adopter sees, update README.md and `docs/` in the same pull request.

## Checks

Run these before you push; CI runs the same:

```bash
npm test                 # node --test, Node 22 or later
bash -n deploy/*.sh
shellcheck deploy/*.sh
```

## Pull requests

- One topic per pull request, with a description of why, what, and how it was checked.
- Pull requests are squash-merged; the pull request title becomes the commit subject.
- Write in English.
