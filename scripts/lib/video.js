'use strict';

/**
 * Company policy: every PR ships with a walkthrough video.
 * We match the link against known recording/hosting services rather than accepting any
 * URL, so a link to a ticket or a doc does not silently satisfy the policy.
 */
const DEFAULT_HOSTS = [
  'loom.com',
  'vimeo.com',
  'youtube.com',
  'youtu.be',
  'wistia.com',
  'vidyard.com',
  'descript.com',
  'scribehow.com',
  'tella.tv',
  'veed.io',
  'screen.studio',
  'zoom.us',
  'drive.google.com',
  'claap.io',
  'bubbles.video',
];

const URL_RE = /https?:\/\/[^\s<>()[\]{}"'`|\\]+/gi;

function normalizeHost(raw) {
  return String(raw).trim().toLowerCase().replace(/^www\./, '');
}

function parseHosts(input) {
  const list = String(input || '')
    .split(/[\s,]+/)
    .map(normalizeHost)
    .filter(Boolean);
  return list.length ? list : DEFAULT_HOSTS;
}

function hostMatches(urlHost, allowed) {
  const h = normalizeHost(urlHost);
  // Suffix match so subdomains (e.g. acme.loom.com) still count, without letting
  // "notloom.com" pass on a naive substring test.
  return allowed.some((a) => h === a || h.endsWith(`.${a}`));
}

/** Find every allowed-host video link in `text`. Returns [{ url, host }]. */
function findVideoLinks(text, hosts = DEFAULT_HOSTS) {
  const found = [];
  const seen = new Set();

  for (const raw of String(text || '').match(URL_RE) || []) {
    // Trim trailing markdown/sentence punctuation the URL regex over-captures.
    const url = raw.replace(/[.,;:!?)\]}>]+$/, '');
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!hostMatches(parsed.hostname, hosts)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ url, host: normalizeHost(parsed.hostname) });
  }
  return found;
}

/**
 * Check a PR for a walkthrough link.
 * `policy` is 'suggest' (default — a missing link is only a nudge) or 'require'
 * (opt-in: a missing link fails the run so branch protection can block the merge).
 */
function checkVideoPolicy({ ctx, hosts, policy = 'suggest' }) {
  // Default here too: a caller that omits hosts must still get a renderable result.
  const allowed = Array.isArray(hosts) && hosts.length ? hosts : DEFAULT_HOSTS;
  const haystack = [ctx.body, ctx.title, ...(ctx.commits || [])].join('\n');
  const links = findVideoLinks(haystack, allowed);
  return {
    links,
    ok: links.length > 0,
    required: policy === 'require',
    policy,
    hosts: allowed,
  };
}

function renderVideoSection(result) {
  if (result.ok) {
    const list = result.links.map((l) => `[${l.host}](${l.url})`).join(', ');
    return `✅ **Walkthrough video:** ${list} — this link will be attached to the playbook entry.`;
  }
  const hint = `Recognised hosts: ${result.hosts.slice(0, 6).join(', ')}${result.hosts.length > 6 ? ', …' : ''}.`;
  if (result.required) {
    return `❌ **Walkthrough video missing.** This repo sets \`video_policy: require\`, so the check fails until one is linked. ${hint}`;
  }
  return [
    `💡 **Consider adding a walkthrough video.** Drop a link in the PR description and it will be`,
    `attached to the playbook entry, so the docs keep a recording per capability.`,
    `Nothing is blocked either way — the entry above is built from this PR regardless. ${hint}`,
  ].join(' ');
}

module.exports = { findVideoLinks, checkVideoPolicy, renderVideoSection, parseHosts, DEFAULT_HOSTS };
