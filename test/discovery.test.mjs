import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';

import { createAppJwt, installationToken } from '../discovery/app-auth.mjs';
import { parseConfig } from '../discovery/config.mjs';
import { discoverRepos } from '../discovery/discover.mjs';
import { reconcile } from '../discovery/main.mjs';
import { buildValues, planChanges, releaseName, stableJson } from '../discovery/plan.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const config = parseConfig(JSON.stringify({ owner: 'me', appId: 'Iv1.test', installationId: 42, privateKeyPath: '/etc/spillway/app.pem', repos: { big: { memory: '8Gi', priorityClassName: 'spillway-high' } } }));

const repo = (name, extra = {}) => ({ name, full_name: `me/${name}`, html_url: `https://github.com/me/${name}`, private: true, archived: false, disabled: false, owner: { login: 'me' }, ...extra });

function fakeClient({ repositories, workflows }) {
  return {
    async paginate(path, key) {
      if (path === '/installation/repositories') return repositories;
      const m = path.match(/^\/repos\/me\/([^/]+)\/actions\/workflows$/);
      if (m) return workflows[m[1]] ?? [];
      throw new Error(`unexpected ${path} ${key}`);
    },
  };
}

function fakeHelm(installed = {}) {
  const calls = [];
  return {
    calls,
    async list(prefix) { return Object.keys(installed).filter((n) => n.startsWith(prefix)); },
    async values(name) { return installed[name]; },
    async apply(name, chart, values) { calls.push(['apply', name, chart.version, values.githubConfigUrl]); },
    async uninstall(name) { calls.push(['uninstall', name]); },
  };
}

test('app JWT: RS256, signed by the key, issued by the app, valid for under 10 minutes', () => {
  const now = Date.UTC(2026, 9, 12, 0, 0, 0);
  const jwt = createAppJwt({ appId: 'Iv1.test', privateKeyPem, now });
  const [h, p, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'RS256', typ: 'JWT' });
  const payload = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(payload.iss, 'Iv1.test');
  assert.equal(payload.iat, now / 1000 - 60);
  assert.ok(payload.exp - now / 1000 <= 600);
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey(privateKey), Buffer.from(s, 'base64url')));
});

test('installation token: asks for the narrowed permissions with the app JWT', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ token: 'installation-token' }), { status: 201 });
  };
  const token = await installationToken({ appId: 'Iv1.test', privateKeyPem, installationId: 42, permissions: { actions: 'read', metadata: 'read' }, fetchImpl, baseUrl: 'https://api.example.invalid' });
  assert.equal(token, 'installation-token');
  assert.equal(seen.url, 'https://api.example.invalid/app/installations/42/access_tokens');
  assert.equal(seen.init.method, 'POST');
  assert.match(seen.init.headers.authorization, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.deepEqual(JSON.parse(seen.init.body), { permissions: { actions: 'read', metadata: 'read' } });
});

test('config: refuses an inline private key and checks required fields and overrides', () => {
  assert.throws(() => parseConfig(JSON.stringify({ owner: 'me', appId: 1, installationId: 2, privateKeyPath: `-----BEGIN ${'RSA PRIVATE'} KEY-----` })), /contains a private key/);
  assert.throws(() => parseConfig(JSON.stringify({ owner: 'me', appId: 1, installationId: 2 })), /privateKeyPath/);
  assert.throws(() => parseConfig(JSON.stringify({ owner: 'me', appId: 1, installationId: 2, privateKeyPath: '/k', repos: { a: { image: 'x' } } })), /repos\.a\.image/);
  assert.throws(() => parseConfig(JSON.stringify({ owner: 'me', appId: 1, installationId: 2, privateKeyPath: '/k', releasePrefix: 'Spill' })), /releasePrefix/);
  assert.equal(config.chart.version, '0.14.2');
  assert.equal(config.defaults.maxRunners, 2);
});

test('discovery: serves private repositories that have the active workflow, and never public ones', async () => {
  const wf = (state = 'active') => [{ path: '.github/workflows/spillway.yml', state }];
  const client = fakeClient({
    repositories: [
      repo('app'),
      repo('site', { private: false }),
      repo('old', { archived: true }),
      repo('quiet'),
      repo('paused'),
      repo('skipme'),
      repo('theirs', { owner: { login: 'other' }, full_name: 'other/theirs' }),
    ],
    workflows: { app: wf(), site: wf(), old: wf(), quiet: [{ path: '.github/workflows/ci.yml', state: 'active' }], paused: wf('disabled_manually'), skipme: wf() },
  });
  const { selected, skipped } = await discoverRepos({ client, owner: 'me', workflowPath: '.github/workflows/spillway.yml', exclude: ['skipme'], include: ['quiet', 'site'] });
  // quiet is served through include before its workflow lands; site stays out because it is public.
  assert.deepEqual(selected.map((r) => r.name), ['app', 'quiet']);
  const why = Object.fromEntries(skipped.map((s) => [s.repo, s.why]));
  assert.match(why['me/site'], /public/);
  assert.match(why['me/old'], /archived/);
  assert.match(why['me/paused'], /disabled_manually/);
  assert.match(why['me/skipme'], /excluded/);
  assert.match(why['other/theirs'], /another owner/);
});

test('release names: lowercase DNS labels, short, stable, and distinct for long names', () => {
  assert.equal(releaseName('MyApp', 'spillway-'), 'spillway-myapp');
  assert.equal(releaseName('data_pipe-line', 'spillway-'), 'spillway-data-pipe-line');
  assert.match(releaseName('___', 'spillway-'), /^spillway-[0-9a-f]{6}$/);
  const long = releaseName('a-very-long-repository-name-that-keeps-going-on', 'spillway-');
  assert.ok(long.length <= 45);
  assert.match(long, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
  assert.notEqual(long, releaseName('a-very-long-repository-name-that-keeps-going-on-2', 'spillway-'));
});

test('values: one scale set per repository, a shared runs-on label, per-repo overrides, no service account token', () => {
  const v = buildValues({ name: 'big', url: 'https://github.com/me/big' }, config);
  assert.equal(v.githubConfigUrl, 'https://github.com/me/big');
  // Distinct names (ARC derives resource names from them), one shared label for runs-on.
  assert.equal(v.runnerScaleSetName, 'spillway-big');
  assert.deepEqual(v.scaleSetLabels, ['spillway']);
  assert.notEqual(buildValues({ name: 'other', url: 'https://github.com/me/other' }, config).runnerScaleSetName, v.runnerScaleSetName);
  assert.equal(v.githubConfigSecret, 'spillway-github-app');
  assert.equal(v.template.spec.priorityClassName, 'spillway-high');
  assert.equal(v.template.spec.automountServiceAccountToken, false);
  assert.deepEqual(v.template.spec.containers[0].resources, { requests: { cpu: '1500m', memory: '8Gi' }, limits: { memory: '8Gi' } });
  assert.equal(stableJson({ b: 1, a: [{ d: 1, c: 2 }] }), stableJson({ a: [{ c: 2, d: 1 }], b: 1 }));
});

test('plan: installs, upgrades, keeps and uninstalls, and never touches foreign releases', () => {
  const values = (url) => buildValues({ name: 'x', url }, config);
  const desired = [
    { repo: { fullName: 'me/new' }, release: 'spillway-new', values: values('https://github.com/me/new') },
    { repo: { fullName: 'me/same' }, release: 'spillway-same', values: values('https://github.com/me/same') },
    { repo: { fullName: 'me/changed' }, release: 'spillway-changed', values: values('https://github.com/me/changed') },
  ];
  const installed = [
    { name: 'spillway-same', values: values('https://github.com/me/same') },
    { name: 'spillway-changed', values: { ...values('https://github.com/me/changed'), maxRunners: 9 } },
    { name: 'spillway-gone', values: {} },
    { name: 'arc', values: {} },
  ];
  const ops = Object.fromEntries(planChanges({ desired, installed, prefix: 'spillway-' }).map((a) => [a.release, a.op]));
  assert.deepEqual(ops, { 'spillway-new': 'install', 'spillway-same': 'keep', 'spillway-changed': 'upgrade', 'spillway-gone': 'uninstall' });
  assert.throws(() => planChanges({ desired: [desired[0], { ...desired[1], release: 'spillway-new' }], installed: [], prefix: 'spillway-' }), /both map/);
});

test('reconcile: plans without applying unless asked, then applies the plan', async () => {
  const client = fakeClient({ repositories: [repo('app')], workflows: { app: [{ path: '.github/workflows/spillway.yml', state: 'active' }] } });
  const quiet = () => {};
  const dry = fakeHelm({ 'spillway-gone': {} });
  const plan = await reconcile({ config, client, helm: dry, apply: false, log: quiet });
  assert.deepEqual(plan.actions.map((a) => a.op), ['install', 'uninstall']);
  assert.equal(dry.calls.length, 0);
  const live = fakeHelm({ 'spillway-gone': {} });
  await reconcile({ config, client, helm: live, apply: true, log: quiet });
  assert.deepEqual(live.calls, [['apply', 'spillway-app', '0.14.2', 'https://github.com/me/app'], ['uninstall', 'spillway-gone']]);
});

test('helm: lists every state, passes values through a file that is removed, and scopes to the namespace', async () => {
  const { createHelm } = await import('../discovery/helm.mjs');
  const { existsSync, readFileSync } = await import('node:fs');
  const calls = [];
  let valuesFile;
  const exec = async (bin, args) => {
    calls.push([bin, ...args]);
    if (args[0] === 'list') return { stdout: JSON.stringify([{ name: 'spillway-app' }, { name: 'other' }]) };
    if (args[0] === 'upgrade') {
      valuesFile = args[args.indexOf('--values') + 1];
      assert.deepEqual(JSON.parse(readFileSync(valuesFile, 'utf8')), { maxRunners: 2 });
    }
    return { stdout: '' };
  };
  const helm = createHelm({ namespace: 'arc-runners', exec });
  assert.deepEqual(await helm.list('spillway-'), ['spillway-app']);
  await helm.apply('spillway-app', { ref: 'oci://example.invalid/chart', version: '0.14.2' }, { maxRunners: 2 });
  assert.equal(existsSync(valuesFile), false);
  assert.deepEqual(calls[0], ['helm', 'list', '--all', '--output', 'json', '--filter', '^spillway-', '--namespace', 'arc-runners']);
  assert.deepEqual(calls[1].slice(0, 7), ['helm', 'upgrade', '--install', 'spillway-app', 'oci://example.invalid/chart', '--version', '0.14.2']);
  assert.deepEqual(calls[1].slice(-2), ['--namespace', 'arc-runners']);
});
