#!/usr/bin/env node
'use strict';

/**
 * Cut a release: move everything currently under `# Unreleased` into a dated
 * docs/release-YYYY-MM-DD.md, empty the changelog, and advance the base marker
 * to HEAD so "unreleased" means "since this release".
 *
 *   node scripts/make-release.js --title "v1.4.0" [--docs-dir docs] [--dry-run]
 *
 * Two output formats:
 *   --format dated-file     (default) a new docs/release-YYYY-MM-DD.md per release
 *   --format release-notes  prepend a dated section to an existing hand-curated
 *                           docs/release-notes.md, e.g.
 *                             ## July 21, 2026 (released by Dana)
 *                             (blank)
 *                               - Title [(#960)](https://github.com/o/r/issues/960)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const md = require('./lib/markdown');

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

/** "2026-07-21" -> "July 21, 2026", the form the hand-curated notes use. */
function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${d}, ${y}`;
}

/** owner/repo from the origin remote, for issue links. */
function repoSlug(explicit) {
  if (explicit) return explicit;
  const url = git(['remote', 'get-url', 'origin'], true);
  const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  return m ? m[1] : null;
}

/**
 * "- Title (#960)" -> "  - Title [(#960)](https://github.com/o/r/issues/960)"
 * GitHub redirects /issues/N to /pull/N when N is a PR, so one link form covers both.
 */
function toNotesBullet(entry, linkBase) {
  const text = entry.replace(/^\s*[-*]\s+/, '').trim();
  const m = /\s*\(#(\d+)\)\s*$/.exec(text);
  if (!m || !linkBase) return `  - ${text}`;
  const title = text.slice(0, m.index).trim();
  return `  - ${title} [(#${m[1]})](${linkBase}/${m[1]})`;
}

function git(args, tolerant = false) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch (err) {
    if (tolerant) return '';
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

function main() {
  const title = arg('title');
  if (!title) {
    console.error('error: --title is required, e.g. --title "v1.4.0"');
    process.exit(2);
  }

  const docsDir = path.resolve(process.cwd(), arg('docs-dir', 'docs'));
  const changelogPath = path.join(docsDir, 'changelog.md');
  if (!fs.existsSync(changelogPath)) {
    console.error(`error: ${changelogPath} not found — nothing to release.`);
    process.exit(2);
  }

  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const entries = md.unreleasedEntries(changelog);
  if (!entries.length) {
    console.error('error: no unreleased entries — nothing to cut.');
    process.exit(1);
  }

  const base = md.getChangelogBase(changelog) || 'unknown';
  const head = git(['rev-parse', 'HEAD']);
  const date = arg('date') || new Date().toISOString().slice(0, 10);
  const format = arg('format', 'dated-file');
  const emptied = md.emptyChangelog(changelog, head);

  if (format === 'release-notes') {
    const releasedBy = arg('released-by');
    if (!releasedBy) {
      console.error('error: --released-by "Name" is required for --format release-notes');
      process.exit(2);
    }
    const notesPath = path.resolve(process.cwd(), arg('notes-file', path.join(arg('docs-dir', 'docs'), 'release-notes.md')));
    const slug = repoSlug(arg('repo'));
    const linkBase = arg('link-base') || (slug ? `https://github.com/${slug}/issues` : null);
    if (!linkBase) console.error('warning: no GitHub remote found; entries will have no issue links.');

    const section = [
      `## ${longDate(date)} (released by ${releasedBy})`,
      '',
      ...entries.map((e) => toNotesBullet(e, linkBase)),
      '',
    ].join('\n');

    const existing = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : '';
    // Newest first, matching how the file is already maintained.
    const updated = existing.trim() ? `${section}\n${existing.replace(/^\n+/, '')}` : section;

    if (has('dry-run')) {
      console.log(`--- would prepend to ${notesPath} ---\n${section}`);
      console.log(`--- would reset ${changelogPath} ---\n${emptied}`);
      return;
    }

    fs.writeFileSync(notesPath, updated);
    fs.writeFileSync(changelogPath, emptied);
    console.log(`Prepended ${entries.length} entr(ies) to ${path.relative(process.cwd(), notesPath)}.`);
    console.log(`Reset changelog; base advanced to ${head.slice(0, 7)}.`);
    console.log('\nNext:');
    console.log(`  git add ${path.relative(process.cwd(), notesPath)} ${path.relative(process.cwd(), changelogPath)}`);
    console.log(`  git commit -m "docs: release notes for ${longDate(date)}"`);
    return;
  }

  const releasePath = path.join(docsDir, `release-${date}.md`);

  const range = base === 'unknown' || base === 'HEAD' ? `…${head.slice(0, 7)}` : `${base.slice(0, 7)}…${head.slice(0, 7)}`;
  const release = [
    `# ${title}`,
    '',
    `_Released ${date} · covers ${range} · ${entries.length} change(s)._`,
    '',
    ...entries,
    '',
  ].join('\n');

  if (has('dry-run')) {
    console.log(`--- would write ${releasePath} ---\n${release}`);
    console.log(`--- would reset ${changelogPath} ---\n${emptied}`);
    return;
  }

  if (fs.existsSync(releasePath)) {
    console.error(`error: ${releasePath} already exists — pass --date to pick another, or delete it.`);
    process.exit(2);
  }

  fs.writeFileSync(releasePath, release);
  fs.writeFileSync(changelogPath, emptied);

  console.log(`Wrote ${path.relative(process.cwd(), releasePath)} with ${entries.length} entr(ies).`);
  console.log(`Reset changelog; base advanced to ${head.slice(0, 7)}.`);
  console.log('\nNext:');
  console.log(`  git add ${path.relative(process.cwd(), releasePath)} ${path.relative(process.cwd(), changelogPath)}`);
  console.log(`  git commit -m "docs: cut release ${title}"`);
}

main();
