'use strict';

const { execFileSync } = require('node:child_process');

const { redact } = require('./redact');

const NOISE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|go\.sum|composer\.lock)$/,
  /(^|\/)(dist|build|vendor|node_modules|\.next|coverage)\//,
  /\.(min\.js|min\.css|map|snap|png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip)$/i,
  /(^|\/)docs\/(playbook|changelog)\.md$/,
];

function git(args, opts = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
  } catch (err) {
    if (opts.tolerant) return '';
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

function isNoise(file) {
  return NOISE.some((re) => re.test(file));
}

function truncate(text, max, label) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${label} truncated at ${max} chars]`;
}

/**
 * Teams that title PRs "#960 - Report export drops the final column" are referring to the
 * issue, not the PR, and their release notes cite that number. Parse it when present so the
 * changelog matches how the team already talks; fall back to the PR number otherwise.
 */
function parseIssueRef(title) {
  const m = /^\s*#(\d+)\s*[-–—:]\s*(.+)$/.exec(String(title || ''));
  if (!m) return { issue: null, title: String(title || '').trim() };
  return { issue: Number(m[1]), title: m[2].trim() };
}

/** Minimal glob support for exclude_paths: `*` within a segment, `**` across segments. */
function globToRegExp(glob) {
  const escaped = String(glob).trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function parseExcludes(input) {
  return String(input || '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(globToRegExp);
}

/**
 * Build the compact change description handed to the model.
 * `range` is a git revision range (e.g. "origin/main...HEAD").
 * `dataScope` bounds what leaves the runner:
 *   'metadata' — title, body, commit subjects, changed file paths (no file contents)
 *   'diff'     — the above plus a truncated, redacted diff
 */
function buildContext({ event, range, maxDiffChars, dataScope = 'metadata', excludePaths = [] }) {
  const pr = event.pull_request || {};

  const changedFiles = git(['diff', '--name-only', range], { tolerant: true })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  const excluded = parseExcludes(excludePaths.join ? excludePaths.join(' ') : excludePaths);
  const isExcluded = (f) => excluded.some((re) => re.test(f));

  const signal = changedFiles.filter((f) => !isNoise(f) && !isExcluded(f));
  const skipped = changedFiles.length - signal.length;
  const excludedCount = changedFiles.filter(isExcluded).length;

  const commits = git(['log', '--no-merges', '--format=%s', range], { tolerant: true })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 40);

  // Only read file contents when the repo has opted into sending them.
  const rawDiff = dataScope === 'diff' && signal.length
    ? git(['diff', '--unified=2', range, '--', ...signal], { tolerant: true })
    : '';
  const diff = rawDiff ? redact(truncate(rawDiff, maxDiffChars, 'diff')) : '';

  // The "#N - " prefix is a reference, not part of the change description: strip it from
  // what the model reads so the changelog line does not carry the number twice.
  const { issue, title: cleanTitle } = parseIssueRef(pr.title || commits[0] || 'Untitled change');

  return {
    number: pr.number || 0,
    issueNumber: issue,
    dataScope,
    excludedFiles: excludedCount,
    title: redact(cleanTitle),
    body: redact(truncate((pr.body || '').trim(), 2000, 'body')),
    author: pr.user?.login || '',
    commits: commits.map(redact),
    files: signal.slice(0, 60),
    skippedFiles: skipped,
    diff,
    baseRef: pr.base?.ref || '',
    headSha: pr.head?.sha || git(['rev-parse', 'HEAD'], { tolerant: true }),
    merged: pr.merged === true,
    mergeSha: pr.merge_commit_sha || '',
  };
}

module.exports = { git, buildContext, isNoise, truncate, parseExcludes, globToRegExp, parseIssueRef, NOISE };
