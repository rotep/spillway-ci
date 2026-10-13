// Loads and checks the discovery config. The config names where the App's
// private key lives and never holds the key itself.

import { readFileSync } from 'node:fs';

const DEFAULTS = {
  workflowPath: '.github/workflows/spillway.yml',
  namespace: 'arc-runners',
  releasePrefix: 'spillway-',
  scaleSetName: 'spillway',
  // Name of the Kubernetes secret that holds the App's ID, installation ID and key.
  appSecretName: 'spillway-github-app',
  chart: { ref: 'oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set', version: '0.14.2' },
  controllerServiceAccount: { namespace: 'arc-systems', name: 'arc-gha-rs-controller' },
  runnerImage: 'ghcr.io/actions/actions-runner:2.337.0',
  defaults: { minRunners: 0, maxRunners: 2, cpu: '1500m', memory: '3Gi', priorityClassName: 'spillway-normal' },
  repos: {},
  include: [],
  exclude: [],
};
const OVERRIDABLE = new Set(Object.keys(DEFAULTS.defaults));

export function parseConfig(text) {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    throw new Error('The config contains a private key. Put the key in a file and set privateKeyPath.');
  }
  const raw = JSON.parse(text);
  const config = {
    ...DEFAULTS,
    ...raw,
    chart: { ...DEFAULTS.chart, ...raw.chart },
    controllerServiceAccount: { ...DEFAULTS.controllerServiceAccount, ...raw.controllerServiceAccount },
    defaults: { ...DEFAULTS.defaults, ...raw.defaults },
  };
  for (const key of ['owner', 'appId', 'installationId', 'privateKeyPath']) {
    if (config[key] === undefined || config[key] === '') throw new Error(`Config: "${key}" is required.`);
  }
  if (!/^[a-z][a-z0-9-]*-$/.test(config.releasePrefix)) {
    throw new Error('Config: "releasePrefix" must be lowercase letters, digits and hyphens, and end with a hyphen.');
  }
  for (const key of ['include', 'exclude']) {
    if (!Array.isArray(config[key]) || !config[key].every((n) => typeof n === 'string')) throw new Error(`Config: "${key}" must be a list of repository names.`);
  }
  for (const [repo, override] of Object.entries(config.repos)) {
    for (const key of Object.keys(override)) {
      if (!OVERRIDABLE.has(key)) throw new Error(`Config: repos.${repo}.${key} is not one of ${[...OVERRIDABLE].join(', ')}.`);
    }
  }
  const { minRunners, maxRunners } = config.defaults;
  if (!(Number.isInteger(minRunners) && Number.isInteger(maxRunners) && minRunners >= 0 && maxRunners >= minRunners)) {
    throw new Error('Config: defaults.minRunners and defaults.maxRunners must be integers with 0 <= min <= max.');
  }
  return config;
}

export function loadConfig(file) {
  return parseConfig(readFileSync(file, 'utf8'));
}
