import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { parseConfig } from '../discovery/config.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the example config parses and keeps the key out of the file', () => {
  const config = parseConfig(read('spillway.config.example.json'));
  assert.equal(config.privateKeyPath, '/etc/spillway/app.pem');
  assert.equal(config.scaleSetName, 'spillway');
});

test('the workflow template keeps its guard rails', () => {
  const wf = read('templates/spillway.yml');
  const permissions = wf.match(/^permissions:\n((?: {2}.+\n)+)/m)?.[1];
  assert.equal(permissions, '  contents: read\n  actions: read\n  statuses: write\n', 'permissions must stay minimal');
  assert.doesNotMatch(wf, /secrets:/, 'no secrets go to the pool');
  assert.doesNotMatch(wf, /pull_request_target/, 'pull_request_target would run with secrets on fork code');
  assert.match(wf, /github\.event\.workflow_run\.conclusion == 'failure'/);
  assert.match(wf, /if: >-\n\s+github\.event\.repository\.private &&\n/, 'public repositories never reach the pool');
  assert.equal(wf.match(/runs-on: spillway/g)?.length, 2);
  assert.match(wf, /runs-on: '"spillway"'/);
});

test('the scale set name, label and status context agree across templates, actions and config', () => {
  const config = parseConfig(read('spillway.config.example.json'));
  const decide = read('actions/decide/action.yml');
  const status = read('actions/status/action.yml');
  const agents = read('templates/AGENTS.snippet.md');
  assert.match(decide, /default: spillway\n/);
  assert.match(decide, /default: spillway \/ ci/);
  assert.match(status, /default: spillway \/ ci/);
  assert.match(agents, /`spillway \/ ci`/);
  assert.equal(config.scaleSetName, 'spillway');
});

// The public copy (scripts/export-public.sh) leaves the self-adoption out.
const adoptsItself = existsSync(new URL('../.github/workflows/spillway.yml', import.meta.url));

test('spillway adopts itself with the template unchanged except pinned actions', { skip: !adoptsItself && 'no self-adoption in this copy' }, () => {
  const template = read('templates/spillway.yml');
  const own = read('.github/workflows/spillway.yml');
  const strip = (text) => text
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .replace(/[\w.-]+\/[\w.-]+\/actions\/(decide|status)@\S+/g, 'OWNER/REPO/actions/$1@PIN');
  assert.equal(strip(own), strip(template));
  assert.match(own, /actions\/decide@[0-9a-f]{40}\n/, 'pinned to a full commit SHA');
  assert.match(own, /actions\/status@[0-9a-f]{40}\n/, 'pinned to a full commit SHA');
});

test('the CI is callable with runs-on and ref, and checks out the given ref', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /workflow_call:\n\s+inputs:\n\s+runs-on:/);
  assert.equal(ci.match(/runs-on: \$\{\{ fromJSON\(inputs\.runs-on \|\| '"ubuntu-latest"'\) \}\}/g)?.length, 2);
  assert.equal(ci.match(/ref: \$\{\{ inputs\.ref \}\}/g)?.length, 2);
});
