import { refHead } from '../lib/github.mjs';

// Builds and posts the commit status that carries a fallback result to the
// pull request's head. A workflow_run's own checks attach to the default
// branch, so a commit status on the head SHA is how the result reaches the PR.

const STATES = new Set(['pending', 'success', 'failure', 'error']);
const MAX_DESCRIPTION = 140;

export function buildStatus({ state, context, description, targetUrl }) {
  if (!STATES.has(state)) throw new Error(`State "${state}" is not one of ${[...STATES].join(', ')}.`);
  if (!context) throw new Error('A status context is required.');
  const body = { state, context };
  if (description) body.description = description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION - 1)}…` : description;
  if (targetUrl) body.target_url = targetUrl;
  return body;
}

// For a cancelled CI: the cancelling run is either on a newer head (then the
// old commit should say it was cancelled) or on this same commit (then that
// run reports, and an error from this one would only get in its way).
export async function stillHead({ client, repo, sha, branch }) {
  if (!branch) return false;
  const head = await refHead({ client, repo, name: branch });
  return head?.kind === 'heads' && head.sha === sha;
}

export async function postStatus({ client, repo, sha, ...fields }) {
  if (!/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error(`"${sha}" is not a full commit SHA.`);
  const body = buildStatus(fields);
  await client.request('POST', `/repos/${repo.owner}/${repo.name}/statuses/${sha}`, body);
  return body;
}
