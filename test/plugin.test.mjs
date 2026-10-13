import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// The repository is also a Claude Code plugin marketplace with one plugin at
// its root, so the skills can read docs/, templates/ and deploy/ through
// ${CLAUDE_PLUGIN_ROOT}. `claude plugin validate .` checks the manifests
// against Claude Code itself; these tests keep the skills consistent with
// the rest of the repository without that dependency.

const url = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(url(path), 'utf8');

const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
const skillNames = readdirSync(url('skills')).sort();
const skills = Object.fromEntries(skillNames.map((name) => [name, read(`skills/${name}/SKILL.md`)]));

function frontmatter(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  assert.ok(block, 'SKILL.md starts with a frontmatter block');
  return Object.fromEntries(block.split('\n').map((line) => {
    const at = line.indexOf(':');
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }));
}

test('the marketplace lists the plugin at the repository root under the same name', () => {
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(marketplace.plugins[0].description, plugin.description);
});

test('the plugin follows commits instead of a fixed version', () => {
  // With no version, Claude Code versions the plugin by commit, so users see
  // every change to the skills and the files they read.
  assert.equal(plugin.version, undefined);
  assert.equal(marketplace.plugins[0].version, undefined);
});

test('the skills are adopt, pool and troubleshoot, each named after its directory', () => {
  assert.deepEqual(skillNames, ['adopt', 'pool', 'troubleshoot']);
  for (const [name, text] of Object.entries(skills)) {
    const meta = frontmatter(text);
    assert.equal(meta.name, name);
    assert.ok(meta.description?.length > 40, `${name} has a description`);
  }
});

test('only the user starts the pool skill, and the others stay available to Claude', () => {
  assert.equal(frontmatter(skills.pool)['disable-model-invocation'], 'true');
  assert.equal(frontmatter(skills.adopt)['disable-model-invocation'], undefined);
  assert.equal(frontmatter(skills.troubleshoot)['disable-model-invocation'], undefined);
  for (const text of Object.values(skills)) assert.doesNotMatch(text, /^allowed-tools:/m, 'no tool is pre-approved');
});

test('every file a skill reads through the plugin root exists', () => {
  for (const [name, text] of Object.entries(skills)) {
    for (const [, path] of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+[\w-])/g)) {
      assert.ok(existsSync(url(path)), `${name} reads ${path}`);
    }
  }
});

test('skills spell placeholders only in full', () => {
  // Claude Code substitutes ${user_config.KEY} up to the next closing brace,
  // so a stray "${user_config." in prose swallows the placeholder after it.
  for (const [name, text] of Object.entries(skills)) {
    assert.doesNotMatch(text, /\$\{user_config\.(?!\w+\})/, `${name} has a partial user_config placeholder`);
    assert.doesNotMatch(text, /\$\{CLAUDE_PLUGIN_ROOT(?!\})/, `${name} has a partial CLAUDE_PLUGIN_ROOT placeholder`);
  }
});

test('every user setting a skill uses is declared, and every declared one is used', () => {
  const declared = Object.keys(plugin.userConfig).sort();
  const used = [...new Set(Object.values(skills).flatMap((text) => [...text.matchAll(/\$\{user_config\.(\w+)\}/g)].map((m) => m[1])))].sort();
  assert.deepEqual(used, declared);
  for (const [key, option] of Object.entries(plugin.userConfig)) {
    assert.ok(option.title && option.description, `${key} has a title and a description`);
    assert.notEqual(option.sensitive, true, `${key}: skills see only non-sensitive values`);
  }
});

test('the pool skill passes the settings deploy/pool.sh reads and offers only its commands', () => {
  const pool = read('deploy/pool.sh');
  const variables = [...new Set([...skills.pool.matchAll(/\b(SPILLWAY_[A-Z_]+)\b/g)].map((m) => m[1]))].sort();
  assert.deepEqual(variables, ['SPILLWAY_NET', 'SPILLWAY_PVE_HOST', 'SPILLWAY_SSH']);
  for (const variable of variables) assert.match(pool, new RegExp(`\\$\\{${variable}:-`), `pool.sh reads ${variable}`);
  const usage = [...pool.matchAll(/^# {3}bash deploy\/pool\.sh (\w+(?: \w+)?)/gm)].map((m) => m[1]).sort();
  const hint = frontmatter(skills.pool)['argument-hint'].replace(/^"|"$/g, '').split(' | ').map((c) => c.replace(/ <repo>$/, '')).sort();
  assert.deepEqual(hint, usage);
});

test('the adopt skill pins the actions this repository publishes', () => {
  const template = read('templates/spillway.yml');
  const actions = [...template.matchAll(/uses: ([\w.-]+\/[\w.-]+)\/actions\/(\w+)@/g)];
  assert.equal(actions.length, 2);
  for (const [, repo, action] of actions) {
    assert.match(skills.adopt, new RegExp(`\`${repo}/actions/${action}\``));
    assert.match(skills.adopt, new RegExp(`repos/${repo}/commits/main`));
  }
});
