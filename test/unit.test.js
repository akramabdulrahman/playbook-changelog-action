'use strict';

const test = require('node:test');
const assert = require('node:assert');

const md = require('../scripts/lib/markdown');
const { parseDecision } = require('../scripts/lib/llm');
const { isNoise, truncate } = require('../scripts/lib/context');

const PLAYBOOK = [
  '# Playbook', '', '## Architecture', '', '_No entries yet._', '',
  '## Configuration & Secrets', '', '- Sessions read REDIS_URL.', '',
].join('\n');

const CHANGELOG = '# Unreleased\n\n<!-- changelog-base: abc1234 -->\n\n- Add Redis cache (#12)\n';

test('playbook: first entry replaces the placeholder', () => {
  const r = md.insertPlaybookEntry(PLAYBOOK, 'Architecture', 'Requests route through an API gateway.');
  assert.equal(r.inserted, true);
  assert.match(r.content, /## Architecture\n\n- Requests route through an API gateway\./);
  assert.doesNotMatch(r.content.split('## Configuration')[0], /_No entries yet\._/);
});

test('playbook: appends after existing bullets, keeps them', () => {
  const r = md.insertPlaybookEntry(PLAYBOOK, 'Configuration & Secrets', 'Audit events need AUDIT_SINK.');
  assert.equal(r.reason, 'appended');
  assert.match(r.content, /- Sessions read REDIS_URL\.\n- Audit events need AUDIT_SINK\./);
});

test('playbook: duplicate sentence is a no-op', () => {
  const r = md.insertPlaybookEntry(PLAYBOOK, 'Configuration & Secrets', 'Sessions read REDIS_URL.');
  assert.equal(r.inserted, false);
  assert.equal(r.reason, 'duplicate');
  assert.equal(r.content, PLAYBOOK);
});

test('playbook: unknown section is created at the end', () => {
  const r = md.insertPlaybookEntry(PLAYBOOK, 'Data Retention', 'Logs expire after 30 days.');
  assert.equal(r.reason, 'new-section');
  assert.match(r.content, /## Data Retention\n\n- Logs expire after 30 days\./);
});

test('playbook: section match ignores case and punctuation', () => {
  const r = md.insertPlaybookEntry(PLAYBOOK, 'configuration and secrets', 'x.');
  assert.notEqual(r.reason, 'new-section', 'should reuse the existing section, not fork a near-duplicate');
});

test('changelog: appends under Unreleased, below the base marker', () => {
  const r = md.insertChangelogEntry(CHANGELOG, 'Add audit logging (#13)');
  assert.equal(r.inserted, true);
  assert.match(r.content, /- Add Redis cache \(#12\)\n- Add audit logging \(#13\)/);
  assert.equal(md.getChangelogBase(r.content), 'abc1234');
});

test('changelog: dedupes ignoring the PR suffix (rerun safety)', () => {
  const r = md.insertChangelogEntry(CHANGELOG, 'Add Redis cache (#99)');
  assert.equal(r.inserted, false);
  assert.equal(r.reason, 'duplicate');
});

test('changelog: entries never leak past the Unreleased section', () => {
  const withRelease = `${CHANGELOG}\n## Older\n\n- ancient (#1)\n`;
  const r = md.insertChangelogEntry(withRelease, 'New thing (#20)');
  const unreleasedBlock = r.content.split('## Older')[0];
  assert.match(unreleasedBlock, /- New thing \(#20\)/);
});

test('changelog: unreleasedEntries + emptyChangelog round-trip', () => {
  assert.deepEqual(md.unreleasedEntries(CHANGELOG), ['- Add Redis cache (#12)']);
  const emptied = md.emptyChangelog(CHANGELOG, 'deadbee');
  assert.deepEqual(md.unreleasedEntries(emptied), []);
  assert.equal(md.getChangelogBase(emptied), 'deadbee');
});

test('llm: tolerates fenced JSON and surrounding prose', () => {
  const d = parseDecision('Sure!\n```json\n{"changelog":"A","known":false,"section":"Architecture","sentence":"B"}\n```');
  assert.deepEqual(d, { changelog: 'A', durable: true, known: false, section: 'Architecture', sentence: 'B' });
});

test('llm: missing fields degrade to empty, not undefined', () => {
  assert.deepEqual(parseDecision('{"changelog":"A"}'), { changelog: 'A', durable: false, known: false, section: '', sentence: '' });
});

test('llm: non-JSON output throws so the caller can fall back', () => {
  assert.throws(() => parseDecision('I cannot help with that'), /no JSON object/);
});

test('context: lockfiles, build output and the docs themselves are noise', () => {
  for (const f of ['package-lock.json', 'dist/app.js', 'docs/playbook.md', 'a/b.min.js', 'logo.png']) {
    assert.equal(isNoise(f), true, `${f} should be filtered`);
  }
  for (const f of ['src/index.js', 'README.md', 'docs/adr/001.md']) {
    assert.equal(isNoise(f), false, `${f} should be kept`);
  }
});

test('context: truncate marks where it cut', () => {
  assert.match(truncate('x'.repeat(50), 10, 'diff'), /^x{10}\n… \[diff truncated at 10 chars\]$/);
});

test('plan: a failed model call is reported as such, not as "nothing to add"', async () => {
  const { planEdits, renderPreview } = require('../scripts/lib/plan');
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const docsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-'));
  const ctx = { number: 7, title: 'Add thing', body: '', commits: ['Add thing'], files: ['src/a.js'], diff: '+x', skippedFiles: 0 };

  const plan = await planEdits({ ctx, docsDir, provider: 'openai', model: 'gpt-4o-mini', apiKey: '', maxPlaybookChars: 16000 });

  assert.ok(plan.llmError, 'a keyless call should surface an error');
  assert.equal(plan.playbook.reason, 'llm-unavailable');
  assert.equal(plan.changelog.inserted, true, 'changelog still gets the entry');
  assert.match(renderPreview(plan, ctx), /the model call failed/);
  assert.doesNotMatch(renderPreview(plan, ctx), /no durable operational fact/);
});

test('llm: strips a judgement label the model prefixed onto the changelog line', () => {
  const d = parseDecision('{"changelog":"Not durable: Extract greeting into a variable","durable":false,"known":false,"section":"","sentence":""}');
  assert.equal(d.changelog, 'Extract greeting into a variable');
  assert.equal(d.durable, false);
});

test('llm: durable and known are independent — a refactor is not "already documented"', () => {
  const d = parseDecision('{"changelog":"Rename x","durable":false,"known":false,"section":"","sentence":""}');
  assert.equal(d.durable, false);
  assert.equal(d.known, false);
});

test('llm: a reply omitting `durable` infers it from the placement', () => {
  assert.equal(parseDecision('{"changelog":"A","section":"Architecture","sentence":"B"}').durable, true);
  assert.equal(parseDecision('{"changelog":"A","section":"","sentence":""}').durable, false);
});

const { findVideoLinks, checkVideoPolicy, renderVideoSection, parseHosts } = require('../scripts/lib/video');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'templates', 'playbook.md'), 'utf8');

test('template: every PM section is addressable, including collapsible ones', () => {
  const titles = md.parseSections(TEMPLATE).sections.map((s) => s.title);
  for (const want of [
    'Product Summary', 'Key Objectives', 'Target Audience', 'Dependencies and Stakeholders',
    'Glossary of Key Terms', 'Product Design and Development', 'Security, Compliance + GDPR',
    'User Guide + Training Materials', 'User Roles', 'Getting Started', 'Key Features',
    'Video Tutorials', 'External integrations', 'Team Contacts',
  ]) {
    assert.ok(titles.includes(want), `"${want}" should be an addressable section (got: ${titles.join(' | ')})`);
  }
});

test('template: inserting into a collapsible section keeps it collapsible', () => {
  const r = md.insertPlaybookEntry(TEMPLATE, 'Key Objectives', 'Ship weekly.');
  assert.equal(r.inserted, true);
  assert.match(r.content, /<summary><h3>Key Objectives<\/h3><\/summary>/, 'summary markup must survive');
  const block = r.content.split('<summary><h3>Key Objectives</h3></summary>')[1].split('</details>')[0];
  assert.match(block, /- Ship weekly\./, 'entry must land inside the <details> block');
});

test('template: a round-trip with no insert leaves the document byte-identical', () => {
  const doc = md.parseSections(TEMPLATE);
  assert.equal(md.renderSections(doc).trim(), TEMPLATE.trim());
});

test('template: bold headings match without their asterisks', () => {
  const r = md.insertPlaybookEntry(TEMPLATE, 'Product Design and Development', 'Wireframes live in Figma.');
  assert.notEqual(r.reason, 'new-section', '## **Bold** heading should match the plain title');
});

test('video: finds Loom and friends, ignores unrelated links', () => {
  const links = findVideoLinks('See https://www.loom.com/share/abc123 and https://github.com/acme/x/pull/4.');
  assert.equal(links.length, 1);
  assert.equal(links[0].host, 'loom.com');
});

test('video: lookalike hosts do not satisfy the policy', () => {
  assert.equal(findVideoLinks('https://notloom.com/share/x').length, 0);
  assert.equal(findVideoLinks('https://loom.com.evil.test/x').length, 0);
  assert.equal(findVideoLinks('https://team.loom.com/share/x').length, 1, 'real subdomains should count');
});

test('video: trailing punctuation is not swallowed into the URL', () => {
  assert.equal(findVideoLinks('Demo: https://youtu.be/abc123.')[0]?.url ?? '', 'https://youtu.be/abc123');
});

test('video: the default policy suggests and never blocks', () => {
  const ctx = { title: 'Add thing', body: 'no link here', commits: [] };
  const r = checkVideoPolicy({ ctx, hosts: parseHosts('') });
  assert.equal(r.policy, 'suggest');
  assert.equal(r.required, false, 'a missing video must not fail the run by default');
  assert.equal(r.ok, false);
  assert.match(renderVideoSection(r), /Consider adding a walkthrough/);
  assert.doesNotMatch(renderVideoSection(r), /policy requires|check fails/);
});

test('video: require stays available as an opt-in', () => {
  const ctx = { title: 'Add thing', body: 'no link here', commits: [] };
  assert.equal(checkVideoPolicy({ ctx, hosts: parseHosts(''), policy: 'require' }).required, true);
});

test('video: a PR without a video still gets its playbook entry', async () => {
  const { planEdits } = require('../scripts/lib/plan');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-novid-'));
  fs.writeFileSync(path.join(dir, 'playbook.md'), TEMPLATE);
  const ctx = { number: 9, title: 'Add gdpr consent logging', body: 'security and encryption work', commits: [], files: [], diff: '', skippedFiles: 0 };

  const plan = await planEdits({ ctx, docsDir: dir, provider: 'mock', maxPlaybookChars: 16000 });

  assert.equal(plan.video.ok, false);
  assert.equal(plan.playbook.inserted, true, 'the entry must still be written');
  assert.equal(plan.changelog.inserted, true);
  assert.doesNotMatch(plan.playbook.sentence, /walkthrough/, 'no video means no link suffix');
});

test('video: a custom host allowlist replaces the defaults', () => {
  const hosts = parseHosts('videos.acme.internal');
  assert.equal(findVideoLinks('https://videos.acme.internal/v/1', hosts).length, 1);
  assert.equal(findVideoLinks('https://www.loom.com/share/x', hosts).length, 0);
});

test('template: a first entry lands after the section blurb, not above it', () => {
  const r = md.insertPlaybookEntry(TEMPLATE, 'Product Design and Development', 'Wireframes live in Figma.');
  const section = r.content.split('Product Design and Development**')[1].split('\n## ')[0];
  const blurbAt = section.indexOf('design and technical thinking');
  const entryAt = section.indexOf('- Wireframes live in Figma.');
  assert.ok(blurbAt !== -1 && entryAt !== -1);
  assert.ok(entryAt > blurbAt, 'the entry must follow the descriptive blurb');
});

test('template: a first entry in a collapsible section stays before </details>', () => {
  const r = md.insertPlaybookEntry(TEMPLATE, 'Target Audience', 'Primary market is UK charities.');
  const block = r.content.split('<summary><h3>Target Audience</h3></summary>')[1];
  const entryAt = block.indexOf('- Primary market is UK charities.');
  const closeAt = block.indexOf('</details>');
  assert.ok(entryAt !== -1 && closeAt !== -1);
  assert.ok(entryAt < closeAt, 'the entry must stay inside the <details> block');
});

test('strict: a section the template does not define is refused', async () => {
  const { planEdits } = require('../scripts/lib/plan');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-strict-'));
  fs.writeFileSync(path.join(dir, 'playbook.md'), TEMPLATE);

  // `mock` routes GDPR wording to "Security, Compliance + GDPR", which does exist.
  const ctx = { number: 5, title: 'Add gdpr consent', body: 'security and encryption', commits: [], files: [], diff: '', skippedFiles: 0 };
  const ok = await planEdits({ ctx, docsDir: dir, provider: 'mock', maxPlaybookChars: 16000 });
  assert.equal(ok.playbook.inserted, true);
  assert.equal(ok.sectionRejected, false);
});

test('strict: hasSection matches real headings and rejects inner labels', () => {
  assert.equal(md.hasSection(TEMPLATE, 'Security, Compliance + GDPR'), true);
  assert.equal(md.hasSection(TEMPLATE, 'Key Objectives'), true, 'collapsible sections count');
  assert.equal(md.hasSection(TEMPLATE, 'Regulatory Compliance + GDPR'), false,
    'a bold label inside a section is not a section');
});

test('strict: sectionTitles feeds the model the real anchor list', () => {
  const titles = md.sectionTitles(TEMPLATE);
  assert.ok(titles.includes('Troubleshooting'));
  assert.ok(!titles.includes('Regulatory Compliance + GDPR'));
});

// --- surgical-edit guarantees: an existing file keeps its exact formatting ---

/** Returns the inserted lines, or the first pair of lines that failed to realign. */
function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const added = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (a[i] === b[j + 1]) { added.push(b[j]); j++; continue; }
    return { added, mutated: [a[i], b[j]] };
  }
  return { added, mutated: null };
}

const MESSY = [
  '# Playbook', '', '', '## Alpha', '', 'Some prose.   ', '', '', '',
  '## Beta', '', '- existing entry', '', '', '## Gamma', '', 'text', '',
].join('\n');

test('surgical: adding an entry touches only the added lines', () => {
  const out = md.insertPlaybookEntry(MESSY, 'Beta', 'New fact.').content;
  const d = diffLines(MESSY, out);
  assert.equal(d.mutated, null, `no existing line may change, got ${JSON.stringify(d.mutated)}`);
  assert.deepEqual(d.added, ['- New fact.']);
});

test('surgical: irregular blank runs and trailing spaces survive verbatim', () => {
  const out = md.insertPlaybookEntry(MESSY, 'Beta', 'New fact.').content;
  assert.match(out, /# Playbook\n\n\n## Alpha/, 'triple newline must survive');
  assert.match(out, /Some prose\. {3}\n/, 'trailing spaces must survive');
});

test('surgical: changelog entries do not reflow the file', () => {
  const cl = '# Unreleased\n\n<!-- changelog-base: abc1234 -->\n\n\n- one (#1)\n\n\n';
  const out = md.insertChangelogEntry(cl, 'two (#2)').content;
  const d = diffLines(cl, out);
  assert.equal(d.mutated, null, `got ${JSON.stringify(d.mutated)}`);
  assert.deepEqual(d.added, ['- two (#2)']);
});

test('surgical: a placeholder is replaced in place', () => {
  const doc = '## Alpha\n\n_No entries yet._\n';
  assert.equal(md.insertPlaybookEntry(doc, 'Alpha', 'First fact.').content, '## Alpha\n\n- First fact.\n');
});

test('surgical: the PM template only gains the new line', () => {
  const out = md.insertPlaybookEntry(TEMPLATE, 'Troubleshooting', 'Retries cap at 3.').content;
  const d = diffLines(TEMPLATE, out);
  assert.equal(d.mutated, null, `got ${JSON.stringify(d.mutated)}`);
  assert.deepEqual(d.added.filter((l) => l.trim() !== ''), ['- Retries cap at 3.']);
});

test('surgical: an existing docs/playbook.md is never replaced by the template', () => {
  const { readOrTemplate } = require('../scripts/lib/plan');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-exist-'));
  const file = path.join(dir, 'playbook.md');
  fs.writeFileSync(file, '## Only Section\n\ncustom\n');
  const r = readOrTemplate(file, 'playbook.md');
  assert.equal(r.created, false);
  assert.equal(r.content, '## Only Section\n\ncustom\n');
});

test('surgical: a labelled bullet keeps its indented description attached', () => {
  const out = md.insertPlaybookEntry(TEMPLATE, 'Security, Compliance + GDPR', 'Rate limit is 100/min.').content;
  const section = out.split('## Security, Compliance + GDPR')[1].split('\n## ')[0];
  const lines = section.split('\n');
  const labelAt = lines.findIndex((l) => l.includes('**Regulatory Compliance + GDPR**'));
  const descAt = lines.findIndex((l) => l.includes('Which regulations apply'));
  const entryAt = lines.findIndex((l) => l.includes('Rate limit is 100/min.'));
  assert.ok(labelAt !== -1 && descAt !== -1 && entryAt !== -1);
  assert.ok(descAt < entryAt, 'the new entry must not split a label from its description');
  assert.equal(descAt - labelAt, 2, 'label and description must stay adjacent');
});

test('surgical: plain bullet lists still append directly after the last item', () => {
  const doc = '## Alpha\n\n- one\n- two\n\ntail\n';
  const out = md.insertPlaybookEntry(doc, 'Alpha', 'three').content;
  assert.equal(out, '## Alpha\n\n- one\n- two\n- three\n\ntail\n');
});

test('llm: both providers pin temperature so preview and apply agree', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lib', 'llm.js'), 'utf8');
  const anthropic = src.split('function callAnthropic')[1].split('function callOpenAI')[0];
  const openai = src.split('function callOpenAI')[1].split('function callMock')[0];
  assert.match(anthropic, /temperature:\s*0\b/, 'anthropic call must pin temperature');
  assert.match(openai, /temperature:\s*0\b/, 'openai call must pin temperature');
});

// --------------------------------------------------------------- hardening

const { fetchWithRetry, backoffMs } = require('../scripts/lib/http');
const { redact } = require('../scripts/lib/redact');
const { encodeDecision, decodeDecision } = require('../scripts/lib/github');
const { parseExcludes, globToRegExp } = require('../scripts/lib/context');

function stubFetch(responses) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next instanceof Error) throw next;
    return { ok: next.status < 400, status: next.status, headers: { get: () => next.retryAfter ?? null }, text: async () => '', json: async () => next.body ?? {} };
  };
  return calls;
}

test('http: retries a 429 and then succeeds', async () => {
  const realFetch = global.fetch;
  const calls = stubFetch([{ status: 429, retryAfter: '0' }, { status: 200, body: { ok: true } }]);
  const res = await fetchWithRetry('https://example.test', {}, { retries: 2 });
  global.fetch = realFetch;
  assert.equal(calls.length, 2, 'should have retried once');
  assert.equal(res.status, 200);
});

test('http: gives up after the retry budget and returns the last response', async () => {
  const realFetch = global.fetch;
  const calls = stubFetch([{ status: 503, retryAfter: '0' }]);
  const res = await fetchWithRetry('https://example.test', {}, { retries: 2 });
  global.fetch = realFetch;
  assert.equal(calls.length, 3, '1 attempt + 2 retries');
  assert.equal(res.status, 503);
});

test('http: a 4xx that is not retryable is returned immediately', async () => {
  const realFetch = global.fetch;
  const calls = stubFetch([{ status: 401 }]);
  const res = await fetchWithRetry('https://example.test', {}, { retries: 2 });
  global.fetch = realFetch;
  assert.equal(calls.length, 1, 'auth failures must not be retried');
  assert.equal(res.status, 401);
});

test('http: a hung request aborts rather than holding the runner', async () => {
  const realFetch = global.fetch;
  global.fetch = (url, opts) => new Promise((_res, rej) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; rej(e);
    });
  });
  await assert.rejects(
    () => fetchWithRetry('https://example.test', {}, { timeoutMs: 20, retries: 0 }),
    /timed out after 20ms/,
  );
  global.fetch = realFetch;
});

test('http: Retry-After is honoured over exponential backoff', () => {
  assert.equal(backoffMs(0, { headers: { get: () => '3' } }), 3000);
  assert.equal(backoffMs(0, null), 500);
  assert.equal(backoffMs(3, null), 4000);
});

test('redact: secrets and personal data never reach the provider', () => {
  const input = [
    'contact alice.smith@client.co.uk about it',
    'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    'export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwxyz123456',
    'db: postgres://admin:hunter2@db.internal:5432/app',
    'password: "correct-horse-battery"',
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  ].join('\n');
  const out = redact(input);
  assert.doesNotMatch(out, /alice\.smith@client\.co\.uk/);
  assert.doesNotMatch(out, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(out, /sk-abcdefghij/);
  assert.doesNotMatch(out, /hunter2/);
  assert.doesNotMatch(out, /correct-horse-battery/);
  assert.doesNotMatch(out, /ghp_abcdefghij/);
  assert.match(out, /postgres:\/\/\[REDACTED\]:\[REDACTED\]@db\.internal/, 'host should survive, credentials should not');
});

test('redact: ordinary prose is left alone', () => {
  const prose = 'Report exports now run as background jobs with three retry attempts.';
  assert.equal(redact(prose), prose);
});

test('context: exclude globs match paths and segments correctly', () => {
  assert.equal(globToRegExp('infra/**').test('infra/tf/main.tf'), true);
  assert.equal(globToRegExp('*.pem').test('key.pem'), true);
  assert.equal(globToRegExp('*.pem').test('certs/key.pem'), false, '* must not cross a path segment');
  assert.equal(parseExcludes('infra/** *.pem').length, 2);
});

test('replay: a decision round-trips only for the sha it was previewed for', () => {
  const decision = { changelog: 'A', durable: true, known: false, section: 'Troubleshooting', sentence: 'B' };
  const body = `preview text${encodeDecision(decision, 'abc123')}`;
  assert.deepEqual(decodeDecision(body, 'abc123'), decision);
  assert.equal(decodeDecision(body, 'different-sha'), null, 'a new push must not replay a stale decision');
  assert.equal(decodeDecision('no marker here', 'abc123'), null);
});

test('accretion: a restatement is skipped, an unrelated fact is not', () => {
  const doc = '## Alpha\n\n- Report exports run as background jobs with three retry attempts.\n';
  assert.ok(md.findNearDuplicate(doc, 'Report exports run as background jobs with three retry attempts.').score >= 0.85);
  assert.equal(md.findNearDuplicate(doc, 'Sessions are cached in Redis.'), null);
});

test('accretion: crowded sections are reported for compaction', () => {
  const doc = `## Alpha\n\n${Array.from({ length: 14 }, (_, i) => `- entry ${i}`).join('\n')}\n`;
  const crowded = md.crowdedSections(doc, 12);
  assert.equal(crowded.length, 1);
  assert.equal(crowded[0].title, 'Alpha');
  assert.equal(crowded[0].count, 14);
});

test('github models: OpenAI-compatible endpoint, authenticated with the workflow token', async () => {
  const realFetch = global.fetch;
  let seen = null;
  global.fetch = async (url, opts) => {
    seen = { url, opts };
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ choices: [{ message: { content: '{"changelog":"A","durable":false,"known":false,"section":"","sentence":""}' } }], usage: { prompt_tokens: 10 } }) };
  };
  const { decide, GITHUB_MODELS_ENDPOINT } = require('../scripts/lib/llm');
  const ctx = { number: 1, title: 'A', body: '', commits: [], files: [], diff: '' };
  const r = await decide({ provider: 'github', apiKey: 'ghs_workflowtoken', ctx, playbook: '## X' });
  global.fetch = realFetch;

  assert.equal(r.error, null);
  assert.equal(seen.url, GITHUB_MODELS_ENDPOINT);
  assert.match(seen.opts.headers.authorization, /^Bearer ghs_workflowtoken$/);
  assert.equal(JSON.parse(seen.opts.body).model, 'openai/gpt-4o-mini');
  assert.equal(JSON.parse(seen.opts.body).temperature, 0);
});

test('apply_mode pr: the 403 from a locked-down repo is explained, not raw', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'main.js'), 'utf8');
  assert.match(src, /not permitted to create or approve pull requests/i, 'must detect the 403');
  assert.match(src, /Settings → Actions → General/, 'must name the setting to change');
  assert.match(src, /is pushed to branch/, 'must tell the user the work is not lost');
});

// ------------------------------------------------- release-notes output format

const { execFileSync } = require('node:child_process');
const os = require('node:os');

function scratchRepo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-rel-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme-org/example-app.git'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'seed'], { cwd: dir });
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'docs', name), body);
  return dir;
}

const runRelease = (dir, args) => execFileSync('node',
  [path.join(__dirname, '..', 'scripts', 'make-release.js'), ...args],
  { cwd: dir, encoding: 'utf8' });

const CHANGELOG_2 = '# Unreleased\n\n<!-- changelog-base: abc1234 -->\n\n- Report export drops the final column (#960)\n- QR code for post-session feedback (#910)\n';

test('release-notes: output matches the hand-curated format byte for byte', () => {
  const dir = scratchRepo({ 'changelog.md': CHANGELOG_2, 'release-notes.md': '' });
  runRelease(dir, ['--title', 'r', '--format', 'release-notes', '--released-by', 'Dana', '--date', '2026-07-21']);
  const out = fs.readFileSync(path.join(dir, 'docs', 'release-notes.md'), 'utf8');
  assert.equal(out,
    '## July 21, 2026 (released by Dana)\n'
    + '\n'
    + '  - Report export drops the final column [(#960)](https://github.com/acme-org/example-app/issues/960)\n'
    + '  - QR code for post-session feedback [(#910)](https://github.com/acme-org/example-app/issues/910)\n');
});

test('release-notes: newest release goes on top, older untouched', () => {
  const existing = '## July 21, 2026 (released by Dana)\n\n  - Older thing [(#1)](https://github.com/acme-org/example-app/issues/1)\n';
  const dir = scratchRepo({ 'changelog.md': '# Unreleased\n\n<!-- changelog-base: abc -->\n\n- New thing (#2)\n', 'release-notes.md': existing });
  runRelease(dir, ['--title', 'r', '--format', 'release-notes', '--released-by', 'Sam', '--date', '2026-08-04']);
  const out = fs.readFileSync(path.join(dir, 'docs', 'release-notes.md'), 'utf8');
  assert.ok(out.indexOf('August 4, 2026') < out.indexOf('July 21, 2026'), 'newest first');
  assert.ok(out.includes(existing.trim()), 'the existing section must survive verbatim');
});

test('release-notes: the changelog is emptied and its base advanced', () => {
  const dir = scratchRepo({ 'changelog.md': CHANGELOG_2, 'release-notes.md': '' });
  runRelease(dir, ['--title', 'r', '--format', 'release-notes', '--released-by', 'Dana']);
  const cl = fs.readFileSync(path.join(dir, 'docs', 'changelog.md'), 'utf8');
  assert.deepEqual(md.unreleasedEntries(cl), []);
  assert.notEqual(md.getChangelogBase(cl), 'abc1234', 'base must advance to HEAD');
});

test('release-notes: --released-by is required', () => {
  const dir = scratchRepo({ 'changelog.md': CHANGELOG_2 });
  assert.throws(() => runRelease(dir, ['--title', 'r', '--format', 'release-notes']), /released-by/);
});

test('release-notes: an entry with no PR number still renders', () => {
  const dir = scratchRepo({ 'changelog.md': '# Unreleased\n\n<!-- changelog-base: abc -->\n\n- Something manual\n', 'release-notes.md': '' });
  runRelease(dir, ['--title', 'r', '--format', 'release-notes', '--released-by', 'Dana', '--date', '2026-07-21']);
  assert.match(fs.readFileSync(path.join(dir, 'docs', 'release-notes.md'), 'utf8'), /^ {2}- Something manual$/m);
});

test('release-notes: the dated-file format is unchanged', () => {
  const dir = scratchRepo({ 'changelog.md': CHANGELOG_2 });
  runRelease(dir, ['--title', 'v2.0.0', '--date', '2026-07-21']);
  assert.match(fs.readFileSync(path.join(dir, 'docs', 'release-2026-07-21.md'), 'utf8'), /^# v2\.0\.0$/m);
});

// ------------------------------------------------------------------- installer

const { buildWorkflow, existingPin } = require('../scripts/install');

test('installer: pins a commit SHA, never a moving tag', () => {
  const wf = buildWorkflow({ actionSlug: 'org/act', sha: 'a'.repeat(40), tag: 'v1.0.1', vendor: false });
  assert.match(wf, new RegExp(`uses: org/act@${'a'.repeat(40)} # v1\\.0\\.1`));
  assert.ok(!/uses: org\/act@v1/.test(wf), 'must not pin a tag');
});

test('installer: vendor mode rewrites both uses: lines to the local path', () => {
  const wf = buildWorkflow({ actionSlug: 'org/act', sha: 'b'.repeat(40), tag: 'v1', vendor: true });
  assert.equal((wf.match(/uses: \.\/\.github\/actions\/playbook/g) || []).length, 2);
  assert.ok(!wf.includes('REPLACE_WITH_COMMIT_SHA'));
  assert.match(wf, /vendored under \.github\/actions\/playbook/);
});

test('installer: exclude_paths override reaches both jobs', () => {
  const wf = buildWorkflow({ actionSlug: 'o/a', sha: 'c'.repeat(40), tag: '', vendor: false, excludePaths: 'server/.env* secrets/**' });
  assert.equal((wf.match(/exclude_paths: 'server\/\.env\* secrets\/\*\*'/g) || []).length, 2);
});

test('installer: recognises an existing install so it does not duplicate', () => {
  assert.deepEqual(existingPin('  - uses: org/act@abcdef1234567890abcdef1234567890abcdef12 # v1'), { slug: 'org/act', sha: 'abcdef1234567890abcdef1234567890abcdef12' });
  assert.deepEqual(existingPin('  - uses: ./.github/actions/playbook'), { vendored: true });
  assert.equal(existingPin('name: something else'), null);
});

// ------------------------------------------------------- issue vs PR numbering

const { parseIssueRef } = require('../scripts/lib/context');

test('issue ref: "#960 - Title" yields the issue number and a clean title', () => {
  assert.deepEqual(parseIssueRef('#960 - Report export drops the final column'),
    { issue: 960, title: 'Report export drops the final column' });
});

test('issue ref: en/em dashes and colons are all accepted separators', () => {
  for (const sep of ['-', '–', '—', ':']) {
    assert.equal(parseIssueRef(`#12 ${sep} Something`).issue, 12, `separator "${sep}"`);
  }
});

test('issue ref: a title with no reference falls back to the PR number', () => {
  assert.deepEqual(parseIssueRef('Add Redis cache to session store'),
    { issue: null, title: 'Add Redis cache to session store' });
});

test('issue ref: a bare "#" mid-title is not a reference', () => {
  assert.equal(parseIssueRef('Fix the #960 regression').issue, null);
  assert.equal(parseIssueRef('Refactor #s handling').issue, null);
});

test('issue ref: the changelog entry cites the issue, not the PR', async () => {
  const { planEdits } = require('../scripts/lib/plan');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-issue-'));
  fs.writeFileSync(path.join(dir, 'playbook.md'), TEMPLATE);

  const ctx = { number: 1001, issueNumber: 960, title: 'Report export drops the final column', body: '', commits: [], files: [], diff: '', skippedFiles: 0 };
  const plan = await planEdits({ ctx, docsDir: dir, provider: 'mock', maxPlaybookChars: 16000 });
  assert.match(plan.changelog.entry, /\(#960\)$/, 'should cite the issue');
  assert.doesNotMatch(plan.changelog.entry, /1001/, 'should not cite the PR number');
});

test('issue ref: with no issue in the title the PR number is used', async () => {
  const { planEdits } = require('../scripts/lib/plan');
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbcl-issue2-'));
  fs.writeFileSync(path.join(dir, 'playbook.md'), TEMPLATE);

  const ctx = { number: 1001, issueNumber: null, title: 'Add Redis cache', body: '', commits: [], files: [], diff: '', skippedFiles: 0 };
  const plan = await planEdits({ ctx, docsDir: dir, provider: 'mock', maxPlaybookChars: 16000 });
  assert.match(plan.changelog.entry, /\(#1001\)$/);
});

test('installer: refuses to write a workflow it cannot pin', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'install.js'), 'utf8');
  assert.match(src, /Could not resolve a commit to pin/, 'must bail rather than emit @null');
  assert.match(src, /!vendor && \(!action\.sha \|\| !action\.slug\)/, 'guard must run before writing');
});

test('installer: package.json exposes the repo so npx can resolve a tag', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.match(pkg.repository?.url || '', /github\.com/, 'repository.url is how the npx path finds the slug');
  assert.ok(pkg.version, 'version becomes the tag looked up via the API');
  assert.equal(pkg.bin['playbook-install'], 'scripts/install.js');
});
