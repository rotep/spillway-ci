---
name: troubleshoot
description: Diagnose spillway's fallback CI on a pull request or commit - `spillway / ci` missing, pending or error, the spillway workflow stuck in queued, runner pods Pending, a job that "lost communication with the server", or a job that passes on hosted runners but fails on the pool. Reads the GitHub side itself and asks the user for the pool side. Use when spillway did not run, did not report, or reported something unexpected.
argument-hint: "[pull request number or URL, or commit SHA]"
---

# Diagnose spillway

Target: `$ARGUMENTS` (none means the current branch's pull request). The symptoms and their fixes are in `${CLAUDE_PLUGIN_ROOT}/docs/troubleshooting.md`; read it first and name the section that matches in your answer. How the router decides is in `${CLAUDE_PLUGIN_ROOT}/docs/design.md` ("Router").

## 1. Read the GitHub side

Use `gh` or the GitHub tools; read only.

1. **Head.** The pull request's head SHA and branch, its labels, and whether it comes from a fork or the repository is public (then spillway never runs, by design).
2. **`spillway / ci`.** The commit status on the head SHA (`gh api repos/{owner}/{repo}/commits/<sha>/status`): state, description, target URL.
3. **Hosted CI.** The latest CI run on the head SHA and its jobs (`gh api repos/{owner}/{repo}/actions/runs/<id>/jobs`). For each failed job: `runner_name` and the number of `steps`. A failed job with no runner and no steps **never started**; a job with steps **started and failed**, which is the code's failure and is never covered.
4. **The `spillway` runs** for that head (`workflow_run` after the CI, or `pull_request` for the label): each job's status. The `decide` step prints one line per job of the failed run, then its reason, worded as in the troubleshooting table.

## 2. Match it

- `decide` queued → "The spillway workflow stays queued": the repository has no runner scale set yet, or the pool is down.
- `decide` ran, no status → "The workflow ran, but `spillway / ci` never appeared": quote the reason.
- `error` → "`spillway / ci` is `error`": `could not decide` or `cancelled`.
- `ci` jobs queued for long, or a job "lost communication with the server" → "Runner pods stay `Pending`" or the memory section.
- Passes on hosted runners, fails on the pool → "A job passes on hosted runners but fails on the pool".

## 3. The pool side

`Pending` pods, a missing scale set, the discovery timer and out-of-memory kills can only be seen on the pool. Do not connect to the Proxmox host or the VM yourself. Ask the user to run `/spillway:pool status` (or `plan`), or the command from the troubleshooting section, and read what they paste.

## 4. Report

- The symptom, the evidence (run and job links, the status, the reason line), the matching section, and the next step. Keep facts and inferences apart.
- A fix on the pool or in its config (`include`, `maxRunners`, `memory`, `runnerImage`) is the owner's: give the exact command or config change.
- To retry, re-run the failed `spillway` jobs or add the label `spillway` once. The pool is small and shared by every repository: never loop re-runs or pushes.
- Never widen the workflow's permissions, pass secrets to it, or change its triggers to make it run.
- Whether `spillway / ci` may stand in for the hosted CI is decided by `${CLAUDE_PLUGIN_ROOT}/templates/AGENTS.snippet.md`: only when every failed hosted job never started **and** `spillway / ci` is `success` on the same head SHA. Say which condition fails, if one does.
