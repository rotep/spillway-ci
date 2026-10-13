// The parts of the Actions runtime protocol the actions use: inputs from
// INPUT_* variables, outputs appended to $GITHUB_OUTPUT, and log commands.

import { appendFileSync } from 'node:fs';

export function input(name, { required = false, fallback = '' } = {}) {
  const value = (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
  if (!value && required) throw new Error(`Input "${name}" is required.`);
  return value || fallback;
}

export function setOutput(name, value) {
  const text = String(value);
  if (/[\r\n]/.test(text)) throw new Error(`Output "${name}" must be one line.`);
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${text}\n`);
  else console.log(`${name}=${text}`);
}

export function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::${message.replace(/\r?\n/g, ' ')}`);
  process.exitCode = 1;
}

export function repoFromEnv() {
  const full = process.env.GITHUB_REPOSITORY ?? '';
  const [owner, name] = full.split('/');
  if (!owner || !name) throw new Error('GITHUB_REPOSITORY is not set.');
  return { owner, name, full };
}

export function runUrl() {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env;
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined;
}
