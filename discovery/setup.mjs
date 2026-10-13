#!/usr/bin/env node
// Setup helpers used by the installer (deploy/). Each prints what the next
// step needs and never prints the private key.
//   setup.mjs html --owner <user> [--name <app name>] --out <file>
//   setup.mjs convert --dir /etc/spillway            (reads the redirect address from stdin)
//   setup.mjs installation --dir /etc/spillway --owner <user>
//   setup.mjs config --dir /etc/spillway --owner <user> [--include "repo1 repo2"] --out <file>

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { parseConfig } from './config.mjs';
import { buildManifest, convertManifest, extractCode, findInstallation, installUrl, manifestHtml, writeAppFiles } from './manifest.mjs';

export function buildConfig({ owner, appId, installationId, dir, include = [] }) {
  const text = JSON.stringify({
    owner,
    appId: String(appId),
    installationId: Number(installationId),
    privateKeyPath: path.join(dir, 'app.pem'),
    include,
  }, null, 2);
  parseConfig(text); // fail here rather than in the timer
  return `${text}\n`;
}

async function readLine(prompt) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values: o } = parseArgs({
    args: rest,
    options: { owner: { type: 'string' }, name: { type: 'string' }, out: { type: 'string' }, dir: { type: 'string', default: '/etc/spillway' }, include: { type: 'string', default: '' } },
  });

  if (command === 'html') {
    if (!o.owner || !o.out) throw new Error('html needs --owner and --out');
    writeFileSync(o.out, manifestHtml(buildManifest({ owner: o.owner, name: o.name })));
    console.log(o.out);
    return;
  }

  if (command === 'convert') {
    if (existsSync(path.join(o.dir, 'app.pem'))) {
      console.error(`${path.join(o.dir, 'app.pem')} already exists; keeping the existing App.`);
    } else {
      const code = extractCode(await readLine('Paste the address GitHub opened after "Create GitHub App": '));
      const facts = writeAppFiles(o.dir, await convertManifest({ code }));
      console.error(`Created the App ${facts.slug} (id ${facts.id}). The key is in ${path.join(o.dir, 'app.pem')}.`);
    }
    const facts = JSON.parse(readFileSync(path.join(o.dir, 'app.json'), 'utf8'));
    console.log(installUrl(facts.slug));
    return;
  }

  if (command === 'installation') {
    if (!o.owner) throw new Error('installation needs --owner');
    const facts = JSON.parse(readFileSync(path.join(o.dir, 'app.json'), 'utf8'));
    const found = await findInstallation({ appId: facts.id, privateKeyPem: readFileSync(path.join(o.dir, 'app.pem'), 'utf8'), owner: o.owner });
    if (!found) {
      console.error(`The App is not installed on ${o.owner} yet.`);
      process.exitCode = 3;
      return;
    }
    if (found.repositorySelection !== 'all') console.error('Note: the App is installed on selected repositories only; new repositories will not join on their own.');
    console.log(found.id);
    return;
  }

  if (command === 'config') {
    if (!o.owner || !o.out) throw new Error('config needs --owner and --out');
    const facts = JSON.parse(readFileSync(path.join(o.dir, 'app.json'), 'utf8'));
    const installationId = readFileSync(path.join(o.dir, 'installation-id'), 'utf8').trim();
    const include = o.include.split(/[\s,]+/).filter(Boolean);
    writeFileSync(o.out, buildConfig({ owner: o.owner, appId: facts.id, installationId, dir: o.dir, include }), { mode: 0o600 });
    console.log(o.out);
    return;
  }

  throw new Error('Usage: setup.mjs html|convert|installation|config [options]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
