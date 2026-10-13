import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide, neverStarted } from '../actions/decide/decide.mjs';
import { createClient } from '../actions/lib/github.mjs';
import { buildStatus, postStatus } from '../actions/status/status.mjs';

const repo = { owner: 'me', name: 'app', full: 'me/app' };
const SHA = 'a'.repeat(40);

function fakeClient(routes) {
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
      return {};
    },
  };
}

const jobsPath = '/repos/me/app/actions/runs/7/attempts/1/jobs';
const run = (overrides = {}) => ({
  workflow_run: { id: 7, run_attempt: 1, conclusion: 'failure', head_sha: SHA, head_repository: { full_name: 'me/app' }, ...overrides },
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
  assert.match(result.reason, /Never started: build, lint/);
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
  const pr = (labels) => ({ pull_request: { head: { sha: SHA, repo: { full_name: 'me/app' } }, labels } });
  const yes = await decide({ eventName: 'pull_request', payload: pr([{ name: 'spillway' }]), repo, client: fakeClient({}), label: 'spillway' });
  assert.deepEqual([yes.run, yes.sha], [true, SHA]);
  const no = await decide({ eventName: 'pull_request', payload: pr([{ name: 'other' }]), repo, client: fakeClient({}), label: 'spillway' });
  assert.equal(no.run, false);
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
