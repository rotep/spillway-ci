import { createClient } from '../lib/github.mjs';
import { fail, input, repoFromEnv, runUrl } from '../lib/runtime.mjs';
import { postStatus } from './status.mjs';

try {
  const body = await postStatus({
    client: createClient({ token: input('token', { required: true }) }),
    repo: repoFromEnv(),
    sha: input('sha', { required: true }),
    state: input('state', { required: true }),
    context: input('context', { fallback: 'spillway / ci' }),
    description: input('description'),
    targetUrl: input('target_url', { fallback: runUrl() ?? '' }) || undefined,
  });
  console.log(`Posted ${body.context}: ${body.state}`);
} catch (error) {
  fail(error);
}
