#!/usr/bin/env node
'use strict';

/**
 * Install (or upgrade) the playbook action in a repository.
 *
 *   node install.js                  # install here, pinned to the latest release
 *   node install.js --upgrade        # re-pin an existing install to the latest release
 *   node install.js --vendor         # copy the action in-repo (private action, other owner)
 *   node install.js --dry-run        # print what would change, write nothing
 *
 * It writes files and prints the remaining manual steps. It never commits, never pushes,
 * and never changes repository settings — those are the user's to make.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ACTION_ROOT = path.join(__dirname, '..');
const WORKFLOW_PATH = '.github/workflows/playbook.yml';
const VENDOR_DIR = '.github/actions/playbook';

const has = (f) => process.argv.includes(`--${f}`);
const arg = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};

const c = {
  bold: (s) => `[1m${s}[0m`,
  dim: (s) => `[2m${s}[0m`,
  green: (s) => `[32m${s}[0m`,
  yellow: (s) => `[33m${s}[0m`,
  red: (s) => `[31m${s}[0m`,
};

function sh(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...opts }).trim();
  } catch {
    return null;
  }
}

/** Repo root, remote slug and default branch of the repo we are installing INTO. */
function inspectTarget() {
  const root = sh('git', ['rev-parse', '--show-toplevel']);
  if (!root) {
    console.error(c.red('Not inside a git repository. cd into the repo you want to install into.'));
    process.exit(2);
  }
  const remote = sh('git', ['remote', 'get-url', 'origin'], { cwd: root }) || '';
  const slug = (/github\.com[:/]([^/]+\/[^/.]+)/.exec(remote) || [])[1] || null;
  const head = sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: root });
  const defaultBranch = head ? head.replace(/^origin\//, '') : (sh('git', ['branch', '--show-current'], { cwd: root }) || 'main');
  return { root, slug, defaultBranch, owner: slug ? slug.split('/')[0] : null };
}

/**
 * One GitHub API call, by the best available route.
 *
 * Unauthenticated requests are limited to 60/hour per IP — easily exhausted on a shared
 * network. Falling back silently would make the installer vendor an unpinned copy, so
 * failures are reported, never swallowed.
 *
 * Returns { data } on success, or { error } describing why not.
 */
async function ghApi(pathname) {
  // 1. gh CLI, if installed and authenticated: 5000/hour and no token handling here.
  if (sh('gh', ['auth', 'status']) !== null || sh('gh', ['--version'])) {
    const out = sh('gh', ['api', pathname]);
    if (out) {
      try { return { data: JSON.parse(out) }; } catch { /* fall through */ }
    }
  }
  // 2. A token from the environment, if the caller supplied one.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'playbook-installer' };
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const res = await fetch(`https://api.github.com${pathname}`, { headers });
    if (res.ok) return { data: await res.json() };
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      return { error: 'rate-limited' };
    }
    if (res.status === 404) return { error: 'not-found' };
    return { error: `http-${res.status}` };
  } catch (err) {
    return { error: `network: ${err.message}` };
  }
}

/** true | false | null (could not determine). */
async function isPublicRepo(slug) {
  if (!slug) return null;
  const { data, error } = await ghApi(`/repos/${slug}`);
  if (error) return null;
  return data.private === false;
}

/** Resolve a tag to the commit it points at. Annotated tags need a second deref. */
async function resolveTagSha(slug, tag) {
  const ref = await ghApi(`/repos/${slug}/git/ref/tags/${tag}`);
  if (ref.error || !ref.data?.object) return { sha: null, error: ref.error || 'no-such-tag' };
  if (ref.data.object.type === 'commit') return { sha: ref.data.object.sha };
  const deref = await ghApi(`/repos/${slug}/git/tags/${ref.data.object.sha}`);
  if (deref.error || !deref.data?.object) return { sha: null, error: deref.error || 'deref-failed' };
  return { sha: deref.data.object.sha };
}

/**
 * Where the action itself lives, and the commit to pin.
 * Two cases: run from a git clone (read git), or run via npx, where npm strips .git —
 * then the slug and version come from package.json and the SHA from the API.
 */
async function inspectAction() {
  const remote = sh('git', ['remote', 'get-url', 'origin'], { cwd: ACTION_ROOT }) || '';
  let slug = (/github\.com[:/]([^/]+\/[^/.]+)/.exec(remote) || [])[1] || null;

  if (slug) {
    // Latest semver tag, resolved to a commit (^{} — an annotated tag is not a commit).
    const tags = (sh('git', ['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname'], { cwd: ACTION_ROOT }) || '')
      .split('\n').filter(Boolean);
    const tag = arg('ref', tags[0] || '');
    const sha = tag
      ? sh('git', ['rev-parse', `${tag}^{}`], { cwd: ACTION_ROOT })
      : sh('git', ['rev-parse', 'HEAD'], { cwd: ACTION_ROOT });
    if (sha) return { slug, tag, sha, owner: slug.split('/')[0] };
  }

  // npx / npm install: no git metadata.
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(ACTION_ROOT, 'package.json'), 'utf8')); } catch { /* none */ }
  slug = slug || (/github\.com[:/]([^/]+\/[^/.]+)/.exec(pkg.repository?.url || '') || [])[1] || null;
  const tag = arg('ref', pkg.version ? `v${pkg.version}` : '');
  const resolved = slug && tag ? await resolveTagSha(slug, tag) : { sha: null, error: 'no-slug' };
  return { slug, tag, sha: resolved.sha, resolveError: resolved.error, owner: slug ? slug.split('/')[0] : null };
}

/** Turn an API failure into something the reader can act on. */
function explainApi(error) {
  if (error === 'rate-limited') {
    return [
      '  GitHub\'s unauthenticated API limit (60/hour per IP) is exhausted.',
      c.dim('  Fix by any of:'),
      c.dim('    gh auth login                 # the installer will use the gh CLI'),
      c.dim('    export GH_TOKEN=<token>       # or a token from the environment'),
      c.dim('    --ref v1.2.3                  # or wait for the limit to reset'),
    ].join('\n');
  }
  if (error === 'not-found' || error === 'no-such-tag') {
    return '  That repository or tag does not exist, or is private and this token cannot see it.';
  }
  if (error && error.startsWith('network')) return `  Network error reaching api.github.com — ${error}`;
  return '  Pass --ref <tag>, or run the installer from a clone of the action.';
}

function buildWorkflow({ actionSlug, sha, tag, vendor, excludePaths }) {
  const template = fs.readFileSync(path.join(ACTION_ROOT, 'examples', 'playbook.yml'), 'utf8');
  const uses = vendor ? `./${VENDOR_DIR}` : `${actionSlug}@${sha}${tag ? ` # ${tag}` : ''}`;
  let out = template.replace(/OWNER\/playbook-changelog-action@REPLACE_WITH_COMMIT_SHA # v1\.0\.0/g, uses);
  if (excludePaths) {
    out = out.replace(/exclude_paths: '[^']*'/g, `exclude_paths: '${excludePaths}'`);
  }
  if (vendor) {
    out = out.replace(
      /^# Copy to[\s\S]*?which would change this repo's behaviour with no PR and no notice\./m,
      `# Installed by playbook-changelog-action's installer.\n`
      + `# The action is vendored under ${VENDOR_DIR} because it lives in a private repo\n`
      + `# under a different owner, which GitHub cannot resolve across repositories.\n`
      + `# Once it is published under this org, re-run the installer without --vendor.`,
    );
  }
  return out;
}

function copyVendor(targetRoot, dryRun) {
  const dest = path.join(targetRoot, VENDOR_DIR);
  const copied = [];
  for (const entry of ['action.yml', 'scripts', 'templates']) {
    const from = path.join(ACTION_ROOT, entry);
    const to = path.join(dest, entry);
    copied.push(path.join(VENDOR_DIR, entry));
    if (dryRun) continue;
    fs.rmSync(to, { recursive: true, force: true });
    // The installer itself is not part of what a consuming repo runs.
    fs.cpSync(from, to, { recursive: true, filter: (src) => path.basename(src) !== 'install.js' });
  }
  return copied;
}

/** Detect an existing install so --upgrade is a re-pin, not a duplicate. */
function existingPin(workflow) {
  const m = /uses:\s*([^\s@]+)@([0-9a-f]{7,40})/.exec(workflow);
  if (m) return { slug: m[1], sha: m[2] };
  if (/uses:\s*\.\/\.github\/actions\/playbook/.test(workflow)) return { vendored: true };
  return null;
}

async function main() {
  const dryRun = has('dry-run');
  const target = inspectTarget();
  const action = await inspectAction();

  console.log(c.bold('\nplaybook-changelog-action installer\n'));
  console.log(`  repository       ${target.slug || target.root}`);
  console.log(`  default branch   ${target.defaultBranch}`);
  console.log(`  action source    ${action.slug || ACTION_ROOT}`);
  console.log(`  pinning          ${action.sha ? action.sha.slice(0, 12) : '(unknown)'}${action.tag ? ` (${action.tag})` : ''}`);

  // Only a PRIVATE action fails to resolve across owners. A public one is fine as-is.
  const crossOwner = Boolean(action.owner && target.owner && action.owner !== target.owner);
  const visibility = crossOwner ? await isPublicRepo(action.slug) : true;
  if (visibility === null && crossOwner && !has('vendor') && !has('no-vendor')) {
    console.error(c.red('\n  Could not determine whether the action repo is public.'));
    console.error(explainApi(action.resolveError));
    console.error(c.dim('  Re-run with --vendor or --no-vendor to decide explicitly.\n'));
    process.exit(1);
  }
  const needsVendor = crossOwner && visibility === false;
  const vendor = has('vendor') || (needsVendor && !has('no-vendor'));
  if (needsVendor && !has('vendor') && !has('no-vendor')) {
    console.log(c.yellow(`\n  ! The action is private and lives under "${action.owner}", this repo under "${target.owner}".`));
    console.log(c.yellow('    GitHub cannot resolve a private action across owners, so it will be vendored.'));
    console.log(c.dim('    Publish it, or move it into this org, then re-run with --no-vendor.'));
  }

  const workflowPath = path.join(target.root, WORKFLOW_PATH);
  const current = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : null;
  const pinned = current ? existingPin(current) : null;

  if (pinned && !has('upgrade') && !has('force')) {
    console.log(c.yellow(`\n  Already installed (${pinned.vendored ? 'vendored' : pinned.sha.slice(0, 12)}).`));
    console.log('  Re-run with --upgrade to re-pin to the latest release, or --force to overwrite.\n');
    return;
  }

  // Never write a workflow that cannot resolve: an unpinned `uses:` is a broken install.
  if (!vendor && (!action.sha || !action.slug)) {
    console.error(c.red(`\n  Could not resolve a commit to pin${action.tag ? ` for ${action.tag}` : ''}.`));
    console.error(explainApi(action.resolveError));
    process.exit(1);
  }

  const workflow = buildWorkflow({
    actionSlug: action.slug || 'OWNER/playbook-changelog-action',
    sha: action.sha,
    tag: action.tag,
    vendor,
    excludePaths: arg('exclude-paths'),
  });

  const written = [WORKFLOW_PATH];
  if (!dryRun) {
    fs.mkdirSync(path.dirname(workflowPath), { recursive: true });
    fs.writeFileSync(workflowPath, workflow);
  }
  if (vendor) written.push(...copyVendor(target.root, dryRun));

  console.log(c.bold(`\n  ${dryRun ? 'Would write' : 'Wrote'}:`));
  for (const f of written) console.log(`    ${f}`);

  if (dryRun) {
    console.log(c.dim('\n  --dry-run: nothing was written.\n'));
    return;
  }

  // Remaining steps are settings and a commit — both the user's to perform.
  const settings = target.slug ? `https://github.com/${target.slug}/settings/actions` : 'Settings → Actions → General';
  const vars = target.slug ? `https://github.com/${target.slug}/settings/variables/actions` : 'Settings → Secrets and variables → Actions → Variables';

  console.log(c.bold('\n  Next, three things only you can do:\n'));
  console.log(`  ${c.bold('1.')} Allow Actions to write`);
  console.log(`     ${c.dim(settings)}`);
  console.log('     → Workflow permissions → "Read and write permissions"');
  console.log(`\n  ${c.bold('2.')} Set the provider variable ${c.dim('(a variable, not a secret)')}`);
  console.log(`     ${c.dim(vars)}  → New repository variable`);
  console.log('     LLM_PROVIDER = github');
  if (sh('gh', ['--version'])) {
    console.log(c.dim(`     or: gh variable set LLM_PROVIDER --body github${target.slug ? ` --repo ${target.slug}` : ''}`));
  }
  console.log(`\n  ${c.bold('3.')} Commit and push, then open a PR to see the preview`);
  console.log(c.dim(`     git add ${written.join(' ')}`));
  console.log(c.dim('     git commit -m "ci: self-maintaining playbook and changelog"'));
  console.log(c.dim(`     git push -u origin HEAD`));
  console.log(`\n  ${c.green('Docs:')} ${action.slug ? `https://github.com/${action.slug}/blob/main/docs/installation.md` : 'docs/installation.md'}\n`);
}

if (require.main === module) main().catch((err) => { console.error(c.red(err.message)); process.exit(1); });

module.exports = { buildWorkflow, existingPin, inspectAction, inspectTarget };
