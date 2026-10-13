import { createClient } from '../lib/github.mjs';
import { fail, input, repoFromEnv, runUrl } from '../lib/runtime.mjs';
import { postStatus, stillHead } from './status.mjs';

try {
  const client = createClient({ token: input('token', { required: true }), retries: 3 });
  const repo = repoFromEnv();
  const sha = input('sha', { required: true });
  const branch = input('unless_head');
  if (await stillHead({ client, repo, sha, branch })) {
    console.log(`${sha} is still the head of ${branch}; the run that cancelled this one reports on it.`);
  } else {
    const body = await postStatus({
      client,
      repo,
      sha,
      state: input('state', { required: true }),
      context: input('context', { fallback: 'spillway / ci' }),
      description: input('description'),
      targetUrl: input('target_url', { fallback: runUrl() ?? '' }) || undefined,
    });
    console.log(`Posted ${body.context}: ${body.state}`);
  }
} catch (error) {
  fail(error);
}
