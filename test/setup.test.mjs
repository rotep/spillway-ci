import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { parseConfig } from '../discovery/config.mjs';
import { APP_PERMISSIONS, buildManifest, convertManifest, extractCode, findInstallation, installUrl, manifestHtml, writeAppFiles } from '../discovery/manifest.mjs';
import { buildConfig } from '../discovery/setup.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

test('manifest: exactly the three permissions, no webhook, no events, private', () => {
  const m = buildManifest({ owner: 'me' });
  assert.equal(m.name, 'spillway-me');
  assert.deepEqual(m.default_permissions, { administration: 'write', actions: 'read', metadata: 'read' });
  assert.deepEqual(m.default_permissions, APP_PERMISSIONS);
  assert.equal(m.hook_attributes.active, false);
  assert.deepEqual(m.default_events, []);
  assert.equal(m.public, false);
  assert.throws(() => buildManifest({ owner: 'me; rm -rf /' }), /not a GitHub user name/);
});

test('manifest page: posts the escaped manifest to GitHub', () => {
  const html = manifestHtml(buildManifest({ owner: 'me', name: 'a"b<c>' }));
  assert.match(html, /<form action="https:\/\/github\.com\/settings\/apps\/new" method="post">/);
  assert.match(html, /name="manifest" value="\{&quot;name&quot;:&quot;a\\&quot;b&lt;c&gt;&quot;/);
  assert.doesNotMatch(html, /value="[^"]*"[^>]*"b<c>/);
});

test('code: taken from the redirect address or given bare; anything else is refused', () => {
  assert.equal(extractCode('https://github.com/rotep/spillway-ci?code=abc123DEF_-x&state=1'), 'abc123DEF_-x');
  assert.equal(extractCode('  abcdef1234\r\n'), 'abcdef1234');
  assert.throws(() => extractCode('https://github.com/rotep/spillway-ci'), /No code found/);
});

test('conversion: posts the code without credentials and returns the App', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ id: 7, slug: 'spillway-me', client_id: 'Iv1.x', pem: 'KEY', owner: { login: 'me' }, html_url: 'https://github.com/apps/spillway-me' }), { status: 201 });
  };
  const app = await convertManifest({ code: 'abc', fetchImpl, baseUrl: 'https://api.example.invalid' });
  assert.equal(seen.url, 'https://api.example.invalid/app-manifests/abc/conversions');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers.authorization, undefined);
  assert.equal(app.id, 7);
  const failing = async () => new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  await assert.rejects(convertManifest({ code: 'old', fetchImpl: failing }), /expire after one hour/);
});

test('app files: the key is 0600, the facts file holds no key', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spillway-test-'));
  try {
    const facts = writeAppFiles(path.join(dir, 'etc'), { id: 7, slug: 'spillway-me', client_id: 'Iv1.x', pem: 'KEY-BYTES', owner: { login: 'me' }, html_url: 'u' });
    assert.equal(statSync(path.join(dir, 'etc', 'app.pem')).mode & 0o777, 0o600);
    assert.equal(readFileSync(path.join(dir, 'etc', 'app.pem'), 'utf8'), 'KEY-BYTES');
    const stored = readFileSync(path.join(dir, 'etc', 'app.json'), 'utf8');
    assert.doesNotMatch(stored, /KEY-BYTES/);
    assert.deepEqual(facts, JSON.parse(stored));
    assert.equal(installUrl(facts.slug), 'https://github.com/apps/spillway-me/installations/new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('installation: found by the owner login with the App JWT', async () => {
  let auth;
  const fetchImpl = async (url, init) => {
    auth = init.headers.authorization;
    return new Response(JSON.stringify([
      { id: 1, account: { login: 'someone' }, repository_selection: 'all' },
      { id: 2, account: { login: 'me' }, repository_selection: 'all' },
    ]), { status: 200 });
  };
  assert.deepEqual(await findInstallation({ appId: 7, privateKeyPem, owner: 'me', fetchImpl, baseUrl: 'https://api.example.invalid' }), { id: 2, repositorySelection: 'all' });
  assert.match(auth, /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(await findInstallation({ appId: 7, privateKeyPem, owner: 'nobody', fetchImpl, baseUrl: 'https://api.example.invalid' }), null);
});

test('config: built from the App facts, valid, with the include list', () => {
  const text = buildConfig({ owner: 'me', appId: 7, installationId: '42', dir: '/etc/spillway', include: ['app', 'site'] });
  const config = parseConfig(text);
  assert.equal(config.appId, '7');
  assert.equal(config.installationId, 42);
  assert.equal(config.privateKeyPath, '/etc/spillway/app.pem');
  assert.deepEqual(config.include, ['app', 'site']);
});
