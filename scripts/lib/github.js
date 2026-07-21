'use strict';

const { fetchWithRetry } = require('./http');

const STICKY_MARKER = '<!-- playbook-changelog-action:preview -->';
const DECISION_MARKER = 'playbook-changelog-action:decision';

async function api(path, { token, method = 'GET', body } = {}) {
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const res = await fetchWithRetry(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'playbook-changelog-action',
    },
    body: body ? JSON.stringify(body) : undefined,
  }, { onRetry: (r) => console.log(`::notice::github retry ${r.attempt + 1}: ${r.status || r.error}, waiting ${r.wait}ms`) });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} -> ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Create the preview comment, or edit the existing one so a PR never accumulates duplicates. */
async function upsertStickyComment({ token, repo, issueNumber, body }) {
  const marked = `${STICKY_MARKER}\n${body}`;
  const existing = await api(`/repos/${repo}/issues/${issueNumber}/comments?per_page=100`, { token });
  const mine = existing.find((c) => typeof c.body === 'string' && c.body.includes(STICKY_MARKER));

  if (mine) {
    await api(`/repos/${repo}/issues/comments/${mine.id}`, { token, method: 'PATCH', body: { body: marked } });
    return { action: 'updated', id: mine.id };
  }
  const created = await api(`/repos/${repo}/issues/${issueNumber}/comments`, { token, method: 'POST', body: { body: marked } });
  return { action: 'created', id: created.id };
}

/**
 * The preview comment carries the decision it displayed, keyed by head sha. Apply
 * replays it instead of asking the model again — two calls on the same input can
 * disagree, and the playbook itself may have moved between the two runs.
 */
function encodeDecision(decision, headSha) {
  return `\n<!-- ${DECISION_MARKER}: ${JSON.stringify({ headSha, decision })} -->`;
}

function decodeDecision(body, headSha) {
  const m = new RegExp(`<!--\\s*${DECISION_MARKER}:\\s*(\\{[\\s\\S]*?\\})\\s*-->`).exec(String(body || ''));
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[1]);
    if (!parsed || parsed.headSha !== headSha) return null;
    return parsed.decision;
  } catch {
    return null;
  }
}

/** Find the decision previewed for this exact head sha, if the comment is still there. */
async function findPreviewedDecision({ token, repo, issueNumber, headSha }) {
  try {
    const comments = await api(`/repos/${repo}/issues/${issueNumber}/comments?per_page=100`, { token });
    for (const c of comments) {
      const found = decodeDecision(c.body, headSha);
      if (found) return found;
    }
  } catch (err) {
    console.log(`::warning::could not read the preview comment (${err.message}); recomputing.`);
  }
  return null;
}

async function createPullRequest({ token, repo, head, base, title, body }) {
  return api(`/repos/${repo}/pulls`, { token, method: 'POST', body: { head, base, title, body } });
}

module.exports = {
  api,
  upsertStickyComment,
  createPullRequest,
  findPreviewedDecision,
  encodeDecision,
  decodeDecision,
  STICKY_MARKER,
  DECISION_MARKER,
};
