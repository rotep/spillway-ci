// Decides whether the fallback should run the repository's CI on the home
// pool. It runs only when GitHub-hosted jobs never started (no runner and no
// steps: the included minutes or budget ran out, or no runner was acquired),
// or when a person or session asked for it with the label. A job that started
// and failed is the code's failure, which the fallback must not paper over.
// Fork code never runs on the pool, and neither does anything from a public
// repository: discovery never serves one, and this check holds even while a
// scale set registered before the repository went public is still there.
// A commit that is no longer its branch's head (the pull request moved on) is
// not run either: the pool is small, and the newer head gets its own run.

import { refHead } from '../lib/github.mjs';

export function neverStarted(job) {
  return job.conclusion === 'failure' && (!job.runner_id || (job.steps ?? []).length === 0);
}

export function describeJob(job) {
  return `${job.name}: ${job.conclusion}, runner ${job.runner_name || 'none'}, ${(job.steps ?? []).length} steps`;
}

// The commit a failure of decide itself should be reported on, or undefined
// when the event would never have reached the pool anyway.
export function reportableSha({ eventName, payload, repo }) {
  if (payload.repository?.private === false) return undefined;
  if (eventName === 'pull_request') {
    const pr = payload.pull_request;
    return pr?.head?.repo?.full_name === repo.full ? pr.head.sha : undefined;
  }
  if (eventName === 'workflow_run') {
    const wr = payload.workflow_run;
    return wr?.head_repository?.full_name === repo.full && wr.conclusion === 'failure' ? wr.head_sha : undefined;
  }
  return undefined;
}

// Reads the branch's head now. Only `contents: read` is needed, so the
// workflow keeps its permissions; for a pull request from this repository
// (forks are refused earlier) the branch head is the pull request's head.
// A CI run on a tag push carries the tag's name as its branch; a tag is left
// alone, since it is not moved on by later pushes.
export async function supersededReason({ client, repo, branch, sha }) {
  if (!branch) return undefined;
  const head = await refHead({ client, repo, name: branch });
  if (!head) return `The branch ${branch} no longer exists; ${sha.slice(0, 7)} is not run.`;
  if (head.kind === 'tags' || head.sha === sha) return undefined;
  return `${sha.slice(0, 7)} is no longer the head of ${branch} (now ${String(head.sha).slice(0, 7)}); a newer head is checked on its own.`;
}

export async function decide({ eventName, payload, repo, client, label }) {
  if (payload.repository?.private === false) {
    return { run: false, reason: 'The repository is public; spillway never runs CI for a public repository on the pool.' };
  }
  if (eventName === 'pull_request') {
    const pr = payload.pull_request;
    if (pr?.head?.repo?.full_name !== repo.full) {
      return { run: false, reason: 'The pull request comes from a fork; spillway never runs fork code on the pool.' };
    }
    if (!(pr.labels ?? []).some((l) => l.name === label)) {
      return { run: false, reason: `The pull request does not carry the label ${label}.` };
    }
    const branch = pr.head.ref;
    const superseded = await supersededReason({ client, repo, branch, sha: pr.head.sha });
    if (superseded) return { run: false, sha: pr.head.sha, branch, reason: superseded };
    return { run: true, sha: pr.head.sha, branch, reason: `The label ${label} is on the pull request.` };
  }

  if (eventName === 'workflow_run') {
    const wr = payload.workflow_run;
    if (wr?.head_repository?.full_name !== repo.full) {
      return { run: false, reason: 'The run comes from a fork; spillway never runs fork code on the pool.' };
    }
    if (wr.conclusion !== 'failure') {
      return { run: false, sha: wr.head_sha, reason: `The run ended "${wr.conclusion}"; only failures are checked.` };
    }
    const branch = wr.head_branch ?? undefined;
    const superseded = await supersededReason({ client, repo, branch, sha: wr.head_sha });
    if (superseded) return { run: false, sha: wr.head_sha, branch, reason: superseded };
    const jobs = await client.paginate(
      `/repos/${repo.owner}/${repo.name}/actions/runs/${wr.id}/attempts/${wr.run_attempt}/jobs`,
      'jobs',
    );
    const never = jobs.filter(neverStarted);
    return {
      run: never.length > 0,
      sha: wr.head_sha,
      branch,
      jobs: jobs.map(describeJob),
      reason: never.length > 0
        ? `Never started: ${never.map((j) => j.name).join(', ')}. Running the CI on the pool.`
        : 'Every failed job started; this is the code\'s failure, not a runner problem.',
    };
  }

  return { run: false, reason: `The event "${eventName}" is not handled.` };
}
