// Creating the GitHub App from a manifest, so the operator never handles the
// private key: they click "Create" in the browser and paste back the one-time
// code from the address bar; the pool machine exchanges the code for the App's
// credentials and writes the key straight to disk.

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createClient } from '../actions/lib/github.mjs';
import { createAppJwt } from './app-auth.mjs';

export const APP_PERMISSIONS = Object.freeze({ administration: 'write', actions: 'read', metadata: 'read' });

export function buildManifest({ owner, name = `spillway-${owner}`, homepage = 'https://github.com/rotep/spillway-ci' }) {
  if (!/^[A-Za-z0-9-]+$/.test(owner ?? '')) throw new Error(`"${owner}" is not a GitHub user name.`);
  return {
    name,
    url: homepage,
    // Nothing calls home: the webhook is off and subscribes to no events.
    hook_attributes: { url: homepage, active: false },
    redirect_url: homepage,
    public: false,
    default_permissions: { ...APP_PERMISSIONS },
    default_events: [],
  };
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A local page that posts the manifest to GitHub. GitHub accepts the manifest
// only as a form POST from the operator's logged-in browser.
export function manifestHtml(manifest) {
  const json = escapeHtml(JSON.stringify(manifest));
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Create the spillway GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; line-height: 1.5">
<h1>Create the spillway GitHub App</h1>
<p>This sends the App definition below to GitHub. On GitHub, check the name and press <b>Create GitHub App</b>.
GitHub then opens a page whose address contains <code>?code=…</code>: copy that whole address and paste it into the installer.</p>
<p>Permissions: Administration (read and write), Actions (read), Metadata (read). No webhook. Only on your account.</p>
<form action="https://github.com/settings/apps/new" method="post">
<input type="hidden" name="manifest" value="${json}">
<button type="submit" style="font-size: 1.2rem; padding: .5rem 1rem">Continue to GitHub</button>
</form>
<pre style="background: #f4f4f4; padding: 1rem; overflow: auto">${escapeHtml(JSON.stringify(manifest, null, 2))}</pre>
</body>
</html>
`;
}

export function extractCode(text) {
  const trimmed = (text ?? '').trim();
  const fromUrl = /[?&]code=([A-Za-z0-9_-]+)/.exec(trimmed);
  if (fromUrl) return fromUrl[1];
  if (/^[A-Za-z0-9_-]{8,}$/.test(trimmed)) return trimmed;
  throw new Error('No code found. Paste the whole address GitHub opened after "Create GitHub App" (it contains ?code=).');
}

export async function convertManifest({ code, fetchImpl = globalThis.fetch, baseUrl = 'https://api.github.com' }) {
  const res = await fetchImpl(`${baseUrl}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'spillway' },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.pem || !data?.id) {
    throw new Error(`GitHub did not convert the code (HTTP ${res.status}${data?.message ? ` ${data.message}` : ''}). Codes expire after one hour and work once.`);
  }
  return data;
}

// Writes the key (0600) and the App's public facts (0644). Returns the facts.
export function writeAppFiles(dir, app) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = path.join(dir, 'app.pem');
  writeFileSync(keyFile, app.pem, { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const facts = { id: app.id, client_id: app.client_id, slug: app.slug, owner: app.owner?.login, html_url: app.html_url };
  writeFileSync(path.join(dir, 'app.json'), `${JSON.stringify(facts, null, 2)}\n`, { mode: 0o644 });
  return facts;
}

export function installUrl(slug) {
  return `https://github.com/apps/${slug}/installations/new`;
}

export async function findInstallation({ appId, privateKeyPem, owner, fetchImpl, baseUrl, now }) {
  const client = createClient({ token: createAppJwt({ appId, privateKeyPem, now }), fetchImpl, baseUrl });
  const installations = await client.paginate('/app/installations');
  const mine = installations.find((i) => i.account?.login === owner);
  return mine ? { id: mine.id, repositorySelection: mine.repository_selection } : null;
}
