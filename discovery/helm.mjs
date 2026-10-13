// A thin wrapper over the helm CLI. Values go through a 0600 temporary file,
// never the command line, and the file is removed after each call.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function createHelm({ namespace, bin = 'helm', exec = execFileAsync }) {
  async function helm(args) {
    const { stdout } = await exec(bin, [...args, '--namespace', namespace], { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  return {
    async list(prefix) {
      // --all includes failed and pending releases, so they are repaired or removed too.
      const releases = JSON.parse((await helm(['list', '--all', '--output', 'json', '--filter', `^${prefix}`])) || '[]');
      return releases.map((r) => r.name).filter((name) => name.startsWith(prefix));
    },
    async values(name) {
      return JSON.parse((await helm(['get', 'values', name, '--output', 'json'])) || 'null') ?? {};
    },
    async apply(name, chart, values) {
      const dir = mkdtempSync(path.join(tmpdir(), 'spillway-'));
      const file = path.join(dir, 'values.json');
      try {
        writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
        await helm(['upgrade', '--install', name, chart.ref, '--version', chart.version, '--values', file]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    async uninstall(name) {
      await helm(['uninstall', name]);
    },
  };
}
