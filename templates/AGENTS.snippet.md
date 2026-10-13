## CI fallback (spillway)

Add this section to the repository's `AGENTS.md` or `CLAUDE.md` so that coding agents apply the same merge rule as people.

- GitHub-hosted runners are the primary CI. When their jobs never start (a failed job with no runner and no steps: the minutes or budget ran out, or no runner was acquired), the workflow `spillway` reruns the same CI on the owner's self-hosted pool and posts the commit status `spillway / ci` on the pull request's head.
- Treat `spillway / ci` = success as a substitute for the hosted CI's green **only when both hold**:
  1. every failed hosted job never started (no runner, no steps), and
  2. `spillway / ci` is `success` on the same head SHA.
  Never substitute for a hosted job that started and failed: that is the code's failure.
- When you substitute, say so in the pull request, then merge with the head SHA you checked (`expectedHeadSha`, or `gh pr merge --match-head-commit`).
- The hosted CI's red mark and the `unstable` mergeable state remain; the rule above already assumes them.
- To run the pool on demand, add the label `spillway` to the pull request. The pool is small and shared by every repository: push once after local checks pass, not repeatedly.
- Never widen the workflow's permissions, pass secrets to it, or change its triggers. Pull request code runs on the owner's machines.
- If `spillway / ci` stays `pending` or the jobs stay `queued`, the pool may be down or full. Tell the owner; starting or resizing the pool is the owner's job.
