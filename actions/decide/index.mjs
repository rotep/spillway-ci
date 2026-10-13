import { readFileSync } from 'node:fs';

import { createClient } from '../lib/github.mjs';
import { fail, input, repoFromEnv, runUrl, setOutput } from '../lib/runtime.mjs';
import { postStatus } from '../status/status.mjs';
import { decide } from './decide.mjs';

try {
  const repo = repoFromEnv();
  const client = createClient({ token: input('token', { required: true }) });
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const result = await decide({
    eventName: process.env.GITHUB_EVENT_NAME,
    payload,
    repo,
    client,
    label: input('label', { fallback: 'spillway' }),
  });
  for (const line of result.jobs ?? []) console.log(line);
  console.log(result.reason);
  setOutput('run', result.run ? 'true' : 'false');
  setOutput('sha', result.sha ?? '');
  if (result.run) {
    await postStatus({
      client, repo, sha: result.sha, state: 'pending',
      context: input('context', { fallback: 'spillway / ci' }),
      description: 'Running the CI on the self-hosted pool',
      targetUrl: runUrl(),
    });
  }
} catch (error) {
  fail(error);
}
