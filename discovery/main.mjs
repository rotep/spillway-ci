#!/usr/bin/env node
// spillway discovery: keep one ARC runner scale set per opted-in repository.
//   node discovery/main.mjs --config /etc/spillway/config.json          # plan only
//   node discovery/main.mjs --config /etc/spillway/config.json --apply  # make it so
// Run it from a systemd timer (deploy/systemd/) on the machine that holds the
// helm credentials for the cluster.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { createClient } from '../actions/lib/github.mjs';
import { installationToken } from './app-auth.mjs';
import { loadConfig } from './config.mjs';
import { discoverRepos } from './discover.mjs';
import { createHelm } from './helm.mjs';
import { buildValues, planChanges, releaseName } from './plan.mjs';

export async function reconcile({ config, client, helm, apply, log = console.log }) {
  const { selected, skipped } = await discoverRepos({
    client, owner: config.owner, workflowPath: config.workflowPath, exclude: config.exclude, include: config.include,
  });
  for (const s of skipped) log(`skip    ${s.repo}: ${s.why}`);

  const names = await helm.list(config.releasePrefix);
  const installed = await Promise.all(names.map(async (name) => ({ name, values: await helm.values(name) })));
  const desired = selected.map((repo) => ({ repo, release: releaseName(repo.name, config.releasePrefix), values: buildValues(repo, config) }));
  const actions = planChanges({ desired, installed, prefix: config.releasePrefix });

  const failures = [];
  for (const a of actions) {
    log(`${a.op.padEnd(9)} ${a.release}${a.repo ? ` (${a.repo})` : ''}`);
    if (!apply || a.op === 'keep') continue;
    try {
      if (a.op === 'uninstall') await helm.uninstall(a.release);
      else await helm.apply(a.release, config.chart, a.values);
    } catch (error) {
      failures.push(a.release);
      log(`error   ${a.release}: ${error.message}`);
    }
  }
  if (!apply) log('Plan only. Pass --apply to make these changes.');
  return { actions, failures };
}

async function main() {
  const { values: args } = parseArgs({ options: { config: { type: 'string' }, apply: { type: 'boolean', default: false } } });
  if (!args.config) throw new Error('Usage: main.mjs --config <file> [--apply]');
  const config = loadConfig(args.config);
  const token = await installationToken({
    appId: config.appId,
    installationId: config.installationId,
    privateKeyPem: readFileSync(config.privateKeyPath, 'utf8'),
    permissions: { actions: 'read', metadata: 'read' },
  });
  const { failures } = await reconcile({
    config,
    client: createClient({ token }),
    helm: createHelm({ namespace: config.namespace }),
    apply: args.apply,
  });
  if (failures.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
