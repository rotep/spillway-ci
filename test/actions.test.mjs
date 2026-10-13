import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, neverStarted, reportableSha } from '../actions/decide/decide.mjs';
import { createClient, GitHubError } from '../actions/lib/github.mjs';
import { buildStatus, postStatus, stillHead } from '../actions/status/status.mjs';

const repo = { owner: 'me', name: 'app', full: 'me/app' };
const SHA = 'a'.repeat(40);

// Branch heads are answered from `heads` (branch → SHA; a missing branch is a
// 404). Every branch is at SHA unless a test says otherwise.
function fakeClient(routes, heads = { main: SHA, 'feat/x': SHA }, tags = {}) {
  const calls = [];
  return {
    calls,
    async paginate(path, key) {
      calls.push(['GET', path]);
      const data = routes[path];
      if (!data) throw new Error(`unexpected ${path}`);
      return key ? data[key] : data;
    },
    async request(method, path, body) {
      calls.push([method, path, body]);
      const ref = path.match(/^\/repos\/me\/app\/git\/ref\/(heads|tags)\/(.+)$/);
      if (method === 'GET' && ref) {
        const table = ref[1] === 'heads' ? heads : tags;
        const name = ref[2].split('/').map(decodeURIComponent).join('/');
        if (!(name in table)) throw new GitHubError(`GET ${path}: HTTP 404 Not Found`, 404);
        return { ref: `refs/${ref[1]}/${name}`, object: { sha: table[name] } };
      }
      if (method === 'GET') throw new Error(`unexpected ${path}`);
      return {};
    },
  };
}

const jobsPath = '/repos/me/app/actions/runs/7/attempts/1/jobs';
const run = (overrides = {}) => ({
  workflow_run: { id: 7, run_attempt: 1, conclusion: 'failure', head_sha: SHA, head_branch: 'feat/x', head_repository: { full_name: 'me/app' }, ...overrides },
});

test('a job that failed without a runner or steps never started', () => {
  assert.equal(neverStarted({ conclusion: 'failure', runner_id: 0, steps: [] }), true);
  assert.equal(neverStarted({ conclusion: 'failure', runner_id: null, steps: [{}] }), true);
  assert.equal(neverStarted({ conclusion: 'failure', runner_id: 12, steps: [] }), true);
  assert.equal(neverStarted({ conclusion: 'failure', runner_id: 12, steps: [{}] }), false);
  assert.equal(neverStarted({ conclusion: 'cancelled', runner_id: 0, steps: [] }), false);
});

test('workflow_run: runs when a hosted job never started (minutes ran out)', async () => {
  const client = fakeClient({ [jobsPath]: { jobs: [
    { name: 'build', conclusion: 'failure', runner_id: 0, runner_name: '', steps: [] },
    { name: 'lint', conclusion: 'failure', runner_id: 0, runner_name: '', steps: [] },
  ] } });
  const result = await decide({ eventName: 'workflow_run', payload: run(), repo, client, label: 'spillway' });
  assert.equal(result.run, true);
  assert.equal(result.sha, SHA);
  assert.equal(result.branch, 'feat/x');
  assert.match(result.reason, /Never started: build, lint/);
  assert.deepEqual(client.calls[0], ['GET', '/repos/me/app/git/ref/heads/feat/x', undefined]);
});

const OTHER = 'b'.repeat(40);

test('workflow_run: an older head is not run once its branch moved on, without reading its jobs', async () => {
  const client = fakeClient({}, { 'feat/x': OTHER });
  const result = await decide({ eventName: 'workflow_run', payload: run(), repo, client, label: 'spillway' });
  assert.equal(result.run, false);
  assert.match(result.reason, /no longer the head of feat\/x \(now bbbbbbb\)/);
  assert.equal(client.calls.length, 1);
});

test('workflow_run: a deleted branch is not run, and other API errors propagate', async () => {
  const gone = await decide({ eventName: 'workflow_run', payload: run(), repo, client: fakeClient({}, {}), label: 'spillway' });
  assert.equal(gone.run, false);
  assert.match(gone.reason, /no longer exists/);
  const tagged = fakeClient({ [jobsPath]: { jobs: [{ name: 'build', conclusion: 'failure', runner_id: 0, steps: [] }] } }, {}, { 'v1.0': 'c'.repeat(40) });
  const onTag = await decide({ eventName: 'workflow_run', payload: run({ head_branch: 'v1.0' }), repo, client: tagged, label: 'spillway' });
  assert.equal(onTag.run, true, 'a CI run on a tag push is not superseded by later pushes');
  const broken = fakeClient({});
  broken.request = async () => { throw new GitHubError('GET x: HTTP 502', 502); };
  await assert.rejects(decide({ eventName: 'workflow_run', payload: run(), repo, client: broken, label: 'spillway' }), /HTTP 502/);
});

test('workflow_run: does not cover a job that started and failed', async () => {
  const client = fakeClient({ [jobsPath]: { jobs: [
    { name: 'build', conclusion: 'failure', runner_id: 3, runner_name: 'GitHub Actions 3', steps: [{ name: 'test' }] },
    { name: 'lint', conclusion: 'success', runner_id: 4, runner_name: 'GitHub Actions 4', steps: [{ name: 'lint' }] },
  ] } });
  const result = await decide({ eventName: 'workflow_run', payload: run(), repo, client, label: 'spillway' });
  assert.equal(result.run, false);
  assert.match(result.reason, /code's failure/);
});

test('workflow_run: ignores runs that did not fail, without calling the API', async () => {
  const client = fakeClient({});
  const result = await decide({ eventName: 'workflow_run', payload: run({ conclusion: 'success' }), repo, client, label: 'spillway' });
  assert.equal(result.run, false);
  assert.equal(client.calls.length, 0);
});

test('workflow_run and pull_request: fork code never runs on the pool', async () => {
  const client = fakeClient({});
  const fromFork = await decide({ eventName: 'workflow_run', payload: run({ head_repository: { full_name: 'stranger/app' } }), repo, client, label: 'spillway' });
  assert.equal(fromFork.run, false);
  const pr = { pull_request: { head: { sha: SHA, repo: { full_name: 'stranger/app' } }, labels: [{ name: 'spillway' }] } };
  const labelledFork = await decide({ eventName: 'pull_request', payload: pr, repo, client, label: 'spillway' });
  assert.equal(labelledFork.run, false);
  assert.equal(client.calls.length, 0);
});

test('workflow_run and pull_request: nothing from a public repository runs on the pool', async () => {
  const client = fakeClient({});
  const publicRepo = { repository: { private: false } };
  const fromRun = await decide({ eventName: 'workflow_run', payload: { ...run(), ...publicRepo }, repo, client, label: 'spillway' });
  assert.equal(fromRun.run, false);
  assert.match(fromRun.reason, /public/);
  const pr = { pull_request: { head: { sha: SHA, repo: { full_name: 'me/app' } }, labels: [{ name: 'spillway' }] }, ...publicRepo };
  assert.equal((await decide({ eventName: 'pull_request', payload: pr, repo, client, label: 'spillway' })).run, false);
  assert.equal(client.calls.length, 0);
});

test('pull_request: the label asks for a run on the head SHA', async () => {
  const pr = (labels) => ({ pull_request: { head: { sha: SHA, ref: 'feat/x', repo: { full_name: 'me/app' } }, labels } });
  const yes = await decide({ eventName: 'pull_request', payload: pr([{ name: 'spillway' }]), repo, client: fakeClient({}), label: 'spillway' });
  assert.deepEqual([yes.run, yes.sha, yes.branch], [true, SHA, 'feat/x']);
  const moved = await decide({ eventName: 'pull_request', payload: pr([{ name: 'spillway' }]), repo, client: fakeClient({}, { 'feat/x': OTHER }), label: 'spillway' });
  assert.equal(moved.run, false);
  assert.match(moved.reason, /no longer the head/);
  const no = await decide({ eventName: 'pull_request', payload: pr([{ name: 'other' }]), repo, client: fakeClient({}), label: 'spillway' });
  assert.equal(no.run, false);
});

test('a failure of decide is reported only where the event could have reached the pool', () => {
  assert.equal(reportableSha({ eventName: 'workflow_run', payload: run(), repo }), SHA);
  assert.equal(reportableSha({ eventName: 'workflow_run', payload: run({ conclusion: 'success' }), repo }), undefined);
  assert.equal(reportableSha({ eventName: 'workflow_run', payload: run({ head_repository: { full_name: 'stranger/app' } }), repo }), undefined);
  assert.equal(reportableSha({ eventName: 'workflow_run', payload: { ...run(), repository: { private: false } }, repo }), undefined);
  const pr = (full) => ({ pull_request: { head: { sha: SHA, repo: { full_name: full } } } });
  assert.equal(reportableSha({ eventName: 'pull_request', payload: pr('me/app'), repo }), SHA);
  assert.equal(reportableSha({ eventName: 'pull_request', payload: pr('stranger/app'), repo }), undefined);
  assert.equal(reportableSha({ eventName: 'push', payload: {}, repo }), undefined);
});

test('status: builds a valid body and posts it on a full SHA only', async () => {
  assert.deepEqual(buildStatus({ state: 'success', context: 'spillway / ci' }), { state: 'success', context: 'spillway / ci' });
  assert.equal(buildStatus({ state: 'failure', context: 'c', description: 'x'.repeat(200) }).description.length, 140);
  assert.throws(() => buildStatus({ state: 'done', context: 'c' }), /not one of/);
  const client = fakeClient({});
  await postStatus({ client, repo, sha: SHA, state: 'pending', context: 'spillway / ci', targetUrl: 'https://example.invalid/run' });
  assert.deepEqual(client.calls[0], ['POST', `/repos/me/app/statuses/${SHA}`, { state: 'pending', context: 'spillway / ci', target_url: 'https://example.invalid/run' }]);
  await assert.rejects(postStatus({ client, repo, sha: 'abc', state: 'pending', context: 'c' }), /full commit SHA/);
});

test('status: a cancelled CI stays silent only while its commit is still the branch head', async () => {
  assert.equal(await stillHead({ client: fakeClient({}), repo, sha: SHA, branch: 'feat/x' }), true);
  assert.equal(await stillHead({ client: fakeClient({}, { 'feat/x': OTHER }), repo, sha: SHA, branch: 'feat/x' }), false);
  assert.equal(await stillHead({ client: fakeClient({}, {}), repo, sha: SHA, branch: 'feat/x' }), false);
  const client = fakeClient({});
  assert.equal(await stillHead({ client, repo, sha: SHA, branch: '' }), false);
  assert.equal(client.calls.length, 0);
});

test('client: sends the auth and version headers, pages until a short page, and reports HTTP errors', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    if (url.includes('/missing')) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const page = Number(new URL(url).searchParams.get('page'));
    const count = page === 1 ? 100 : 3;
    return new Response(JSON.stringify({ jobs: Array.from({ length: count }, (_, i) => ({ id: page * 1000 + i })) }), { status: 200 });
  };
  const client = createClient({ token: 'test-token', fetchImpl, baseUrl: 'https://api.example.invalid' });
  const jobs = await client.paginate('/repos/me/app/actions/runs/1/jobs', 'jobs');
  assert.equal(jobs.length, 103);
  assert.equal(seen[0].init.headers.authorization, 'Bearer test-token');
  assert.equal(seen[0].init.headers['x-github-api-version'], '2022-11-28');
  await assert.rejects(client.request('GET', '/missing'), (error) => error.status === 404 && /Not Found/.test(error.message));
});

test('client: retries network failures and 5xx when asked, never a 4xx', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls === 1) throw new TypeError('fetch failed');
    if (calls === 2) return new Response('<html>Service Unavailable</html>', { status: 503 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = createClient({ token: 'test-token', fetchImpl: flaky, retries: 3, sleep, baseUrl: 'https://api.example.invalid' });
  assert.deepEqual(await client.request('GET', '/x'), { ok: true });
  assert.deepEqual(waits, [2000, 4000]);

  let notFound = 0;
  const missing = async () => { notFound++; return new Response('{}', { status: 404 }); };
  const strict = createClient({ token: 'test-token', fetchImpl: missing, retries: 3, sleep, baseUrl: 'https://api.example.invalid' });
  await assert.rejects(strict.request('GET', '/x'), /HTTP 404/);
  assert.equal(notFound, 1);

  const down = async () => { throw new TypeError('fetch failed'); };
  const once = createClient({ token: 'test-token', fetchImpl: down, sleep, baseUrl: 'https://api.example.invalid' });
  await assert.rejects(once.request('GET', '/x'), /fetch failed/);
  const thrice = createClient({ token: 'test-token', fetchImpl: down, retries: 2, sleep, baseUrl: 'https://api.example.invalid' });
  waits.length = 0;
  await assert.rejects(thrice.request('GET', '/x'), /fetch failed/);
  assert.deepEqual(waits, [2000, 4000]);
});
