'use strict';

/**
 * Documentation is tested like code, because it drifts like code. These checks fail when
 * an input is renamed, a link rots, or the docs quote an error the action cannot emit.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOCS_DIR = path.join(ROOT, 'docs');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const docFiles = fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`);
const allMarkdown = ['README.md', 'CHANGELOG.md', ...docFiles];

const actionYml = read('action.yml');
const declaredInputs = [...actionYml.split('outputs:')[0].matchAll(/^ {2}([a-z_]+):$/gm)].map((m) => m[1]);

test('docs: every relative link resolves', () => {
  const broken = [];
  for (const file of allMarkdown) {
    const dir = path.dirname(path.join(ROOT, file));
    for (const m of read(file).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const [filePart] = target.split('#');
      if (!filePart) continue;
      if (!fs.existsSync(path.resolve(dir, filePart))) broken.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(broken, [], `broken links:\n${broken.join('\n')}`);
});

test('docs: every anchor link points at a real heading', () => {
  // GitHub's slugger replaces each space with a hyphen and does NOT collapse runs, so a
  // removed em dash leaves a double hyphen behind.
  const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s/g, '-');
  const broken = [];
  for (const file of allMarkdown) {
    const dir = path.dirname(path.join(ROOT, file));
    for (const m of read(file).matchAll(/\[[^\]]+\]\(([^)]*#[^)]+)\)/g)) {
      const [filePart, anchor] = m[1].split('#');
      if (/^https?:/.test(m[1])) continue;
      const targetPath = filePart ? path.resolve(dir, filePart) : path.join(ROOT, file);
      if (!fs.existsSync(targetPath)) continue; // covered by the link test
      const headings = [...fs.readFileSync(targetPath, 'utf8').matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((h) => slug(h[1]));
      if (!headings.includes(anchor)) broken.push(`${file} -> ${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `broken anchors:\n${broken.join('\n')}`);
});

test('docs: configuration.md documents every action input', () => {
  const config = read('docs/configuration.md');
  const undocumented = declaredInputs.filter((i) => !config.includes(`\`${i}\``));
  assert.deepEqual(undocumented, [], `inputs missing from configuration.md: ${undocumented.join(', ')}`);
});

test('docs: configuration.md invents no inputs', () => {
  const config = read('docs/configuration.md');
  const inputsSection = config.split('## Outputs')[0];
  const tableInputs = [...inputsSection.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
  const invented = tableInputs.filter((i) => !declaredInputs.includes(i));
  assert.deepEqual(invented, [], `documented but not in action.yml: ${invented.join(', ')}`);
});

test('docs: documented defaults match action.yml', () => {
  const config = read('docs/configuration.md');
  const actualDefault = (name) => {
    const block = actionYml.split(`  ${name}:`)[1] || '';
    const m = /default: '?([^'\n]*)'?/.exec(block.split('\n').slice(0, 5).join('\n'));
    return m ? m[1].trim() : null;
  };
  for (const [name, expected] of [
    ['data_scope', 'metadata'],
    ['video_policy', 'suggest'],
    ['allow_new_sections', 'false'],
    ['apply_mode', 'push'],
    ['llm_provider', 'mock'],
  ]) {
    assert.equal(actualDefault(name), expected, `${name} default drifted in action.yml`);
    assert.match(config, new RegExp(`\`${name}\`[^|]*\\|[^|]*\`${expected}\``), `configuration.md states the wrong default for ${name}`);
  }
});

test('docs: quoted log messages exist in the code', () => {
  const sources = ['scripts/main.js', 'scripts/lib/plan.js', 'scripts/lib/video.js', 'scripts/lib/http.js']
    .map(read).join('\n');
  const quoted = [
    'Replaying the decision shown in the preview comment.',
    'No stored preview decision; recomputing.',
    'printing preview instead of commenting',
    'rebasing onto origin/',
    'not permitted to create or approve pull requests',
    'no durable operational fact in this change',
    'this is already covered in the playbook',
  ];
  const missing = quoted.filter((q) => !sources.includes(q));
  assert.deepEqual(missing, [], `troubleshooting.md quotes messages the code never emits: ${missing.join(' | ')}`);
});

test('docs: the pinned SHA in the docs is a real commit on this repo', () => {
  const { execFileSync } = require('node:child_process');
  const shas = new Set();
  for (const file of allMarkdown) {
    for (const m of read(file).matchAll(/@([0-9a-f]{40})/g)) shas.add(m[1]);
  }
  assert.ok(shas.size > 0, 'the docs should pin at least one example SHA');
  for (const sha of shas) {
    const type = execFileSync('git', ['cat-file', '-t', sha], { cwd: ROOT, encoding: 'utf8' }).trim();
    assert.equal(type, 'commit', `${sha} is a ${type}, not a commit — pinning it would fail`);
  }
});

test('docs: the video host list matches the code', () => {
  const { DEFAULT_HOSTS } = require('../scripts/lib/video');
  const config = read('docs/configuration.md');
  const missing = DEFAULT_HOSTS.filter((h) => !config.includes(h));
  assert.deepEqual(missing, [], `configuration.md omits video hosts: ${missing.join(', ')}`);
});

test('docs: the example workflow is valid and matches what installation.md promises', () => {
  const wf = read('examples/playbook.yml');
  assert.match(wf, /types: \[.*edited.*\]/, 'edited trigger must be present');
  assert.match(wf, /group: playbook-apply-\$\{\{ github\.event\.pull_request\.base\.ref \}\}/, 'apply must serialise per base ref');
  assert.match(wf, /models: read/, 'models: read is required for the default provider');
  assert.match(wf, /fetch-depth: 0/, 'full history is required for the diff range');
  assert.ok(!/@v1\s*$/m.test(wf), 'the example must not pin a moving tag');
});

test('docs: a SHA labelled with a version tag really is that tag', () => {
  const { execFileSync } = require('node:child_process');
  const mismatches = [];
  for (const file of allMarkdown) {
    for (const m of read(file).matchAll(/@([0-9a-f]{40})\s*(?:#\s*(v\d+\.\d+\.\d+))/g)) {
      const [, sha, tag] = m;
      let tagSha = null;
      try { tagSha = execFileSync('git', ['rev-parse', `${tag}^{}`], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { /* tag gone */ }
      if (tagSha !== sha) mismatches.push(`${file}: claims ${sha.slice(0, 12)} is ${tag}, but ${tag} is ${tagSha ? tagSha.slice(0, 12) : '(missing)'}`);
    }
  }
  assert.deepEqual(mismatches, [], `version/SHA drift:\n${mismatches.join('\n')}`);
});
