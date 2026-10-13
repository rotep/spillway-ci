// GitHub App authentication without dependencies: an RS256 JWT signed with
// node:crypto, exchanged for an installation token that discovery narrows to
// the permissions it needs (actions:read, metadata:read). The private key is
// read from a file by the caller and never logged.

import { createPrivateKey, sign } from 'node:crypto';

import { createClient } from '../actions/lib/github.mjs';

const b64url = (value) => Buffer.from(value).toString('base64url');

export function createAppJwt({ appId, privateKeyPem, now = Date.now() }) {
  if (!appId) throw new Error('appId is required.');
  // GitHub allows at most 10 minutes; backdate iat for clock drift.
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60, iss: String(appId) }));
  const signingInput = `${header}.${payload}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), createPrivateKey(privateKeyPem));
  return `${signingInput}.${b64url(signature)}`;
}

export async function installationToken({ appId, privateKeyPem, installationId, permissions, fetchImpl, baseUrl, now }) {
  const client = createClient({ token: createAppJwt({ appId, privateKeyPem, now }), fetchImpl, baseUrl });
  const data = await client.request('POST', `/app/installations/${installationId}/access_tokens`, permissions ? { permissions } : undefined);
  if (!data?.token) throw new Error('GitHub returned no installation token.');
  return data.token;
}
