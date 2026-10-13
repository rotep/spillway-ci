import { readFileSync } from 'node:fs';

import { createClient } from '../lib/github.mjs';
import { fail, input, repoFromEnv, runUrl, setOutput } from '../lib/runtime.mjs';
import { postStatus } from '../status/status.mjs';
import { decide, reportableSha } from './decide.mjs';

const eventName = process.env.GITHUB_EVENT_NAME;
const context = input('context', { fallback: 'spillway / ci' });
let repo;
let client;
let payload;

try {
  repo = repoFromEnv();
  client = createClient({ token: input('token', { required: true }), retries: 3 });
  payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await decide({
    eventName,
    payload,
    repo,
    client,
    label: input('label', { fallback: 'spillway' }),
  });
  for (const line of result.jobs ?? []) console.log(line);
  console.log(result.reason);
  if (result.run) {
    await postStatus({
      client, repo, sha: result.sha, state: 'pending',
      context,
      description: 'Running the CI on the self-hosted pool',
      targetUrl: runUrl(),
    });
  }
  // Outputs only after the pending status is up: a failure above leaves run
  // unset, so the report job does not overwrite the error status below.
  setOutput('run', result.run ? 'true' : 'false');
  setOutput('sha', result.sha ?? '');
  setOutput('branch', result.branch ?? '');
} catch (error) {
  fail(error);
  // Leave a visible error on the head instead of no status at all, so a
  // reader does not wait for a run that will never come.
  const sha = payload && repo && client ? reportableSha({ eventName, payload, repo }) : undefined;
  if (sha) {
    const message = error instanceof Error ? error.message : String(error);
    await postStatus({
      client, repo, sha, state: 'error', context,
      description: `spillway could not decide: ${message}`,
      targetUrl: runUrl(),
    }).catch((postError) => console.log(`Could not post the error status: ${postError.message}`));
  }
}
