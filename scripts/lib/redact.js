'use strict';

/**
 * Anything sent to a third-party model passes through here first.
 *
 * Two separate concerns:
 *  - GDPR: personal data (emails, names in trailers) must not leave the runner.
 *  - Secret hygiene: a diff can contain a key someone committed by mistake; sending
 *    it to a provider turns a local mistake into a third-party disclosure.
 *
 * This is defence in depth, not a guarantee. The real control is `data_scope`.
 */

const RULES = [
  [/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
  // Before the email rule: user:pass@host otherwise matches as an email address.
  // Connection strings: keep the scheme and host, drop the credentials.
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s:/@]+)@/gi, '$1[REDACTED]:[REDACTED]@'],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  // password= / api_key: "…" style assignments, value only.
  [/\b((?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*)(['"]?)([^\s'"&]{6,})\2/gi,
    (_m, prefix, quote) => `${prefix}${quote}[REDACTED]${quote}`],
];

function redact(text) {
  let out = String(text || '');
  for (const [pattern, replacement] of RULES) out = out.replace(pattern, replacement);
  return out;
}

/** Count of redactions applied — surfaced in the PR comment so it is visible, not silent. */
function redactionCount(before, after) {
  const marks = String(after).match(/\[REDACTED[_A-Z]*\]/g);
  return marks ? marks.length : (before === after ? 0 : 1);
}

module.exports = { redact, redactionCount, RULES };
