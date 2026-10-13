// Turns the discovered repositories into one ARC runner scale set (one Helm
// release) per repository, and plans the changes against what is installed.
// A personal account can register runners only per repository, so each
// repository gets its own scale set. ARC names a scale set's Kubernetes
// resources after the scale set name, so the names must differ within the
// namespace (the release name); the shared label (scaleSetLabels, ARC 0.14+)
// lets every adopting workflow use the same `runs-on`.

import { createHash } from 'node:crypto';

// ARC derives other resource names from the installation name; keep it short.
const MAX_RELEASE_NAME = 45;

export function releaseName(repoName, prefix) {
  const slug = repoName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  const hash = createHash('sha256').update(repoName).digest('hex').slice(0, 6);
  if (!slug) return `${prefix}${hash}`;
  const name = `${prefix}${slug}`;
  if (name.length <= MAX_RELEASE_NAME) return name;
  return `${name.slice(0, MAX_RELEASE_NAME - hash.length - 1).replace(/-+$/, '')}-${hash}`;
}

export function buildValues(repo, config) {
  const o = { ...config.defaults, ...(config.repos[repo.name] ?? {}) };
  return {
    githubConfigUrl: repo.url,
    githubConfigSecret: config.appSecretName,
    runnerScaleSetName: releaseName(repo.name, config.releasePrefix),
    scaleSetLabels: [config.scaleSetName],
    minRunners: o.minRunners,
    maxRunners: o.maxRunners,
    controllerServiceAccount: config.controllerServiceAccount,
    template: {
      spec: {
        ...(o.priorityClassName ? { priorityClassName: o.priorityClassName } : {}),
        // Jobs never need the Kubernetes API in the default container mode.
        automountServiceAccountToken: false,
        containers: [{
          name: 'runner',
          image: config.runnerImage,
          command: ['/home/runner/run.sh'],
          // Requests make the scheduler the global cap: a runner pod that does
          // not fit waits as Pending, and its job waits in GitHub's queue.
          resources: { requests: { cpu: o.cpu, memory: o.memory }, limits: { memory: o.memory } },
        }],
      },
    },
  };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function planChanges({ desired, installed, prefix }) {
  const owners = new Map();
  for (const d of desired) {
    if (owners.has(d.release)) throw new Error(`${owners.get(d.release)} and ${d.repo.fullName} both map to the release ${d.release}.`);
    owners.set(d.release, d.repo.fullName);
  }
  const byName = new Map(installed.map((i) => [i.name, i]));
  const actions = desired.map((d) => {
    const current = byName.get(d.release);
    const op = !current ? 'install' : stableJson(current.values ?? {}) === stableJson(d.values) ? 'keep' : 'upgrade';
    return { op, release: d.release, repo: d.repo.fullName, values: d.values };
  });
  for (const i of installed) {
    // Never touch a release that discovery did not name.
    if (i.name.startsWith(prefix) && !owners.has(i.name)) actions.push({ op: 'uninstall', release: i.name });
  }
  return actions;
}
