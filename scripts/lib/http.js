'use strict';

/**
 * Every outbound call goes through here. Raw fetch has no timeout, so a hung
 * connection would hold a runner until the 6h job ceiling; and a single 429 from a
 * provider would silently degrade the run to changelog-only.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Honour Retry-After when the server sends one, else exponential backoff. */
function backoffMs(attempt, res) {
  const header = res && res.headers && res.headers.get('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 20_000);
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), 20_000);
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

/**
 * fetch with a hard timeout and bounded retries on transient failures.
 * Returns the Response. Non-retryable error statuses are returned as-is so the
 * caller can read the body and report it.
 */
async function fetchWithRetry(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, onRetry } = {}) {
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      if (!RETRYABLE_STATUS.has(res.status) || attempt === retries) return res;
      const wait = backoffMs(attempt, res);
      if (onRetry) onRetry({ attempt, status: res.status, wait });
      await sleep(wait);
    } catch (err) {
      // AbortError (timeout) and network errors are both worth one more try.
      lastError = err.name === 'AbortError' ? new Error(`request timed out after ${timeoutMs}ms`) : err;
      if (attempt === retries) throw lastError;
      const wait = backoffMs(attempt, null);
      if (onRetry) onRetry({ attempt, error: lastError.message, wait });
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError || new Error('request failed');
}

module.exports = { fetchWithRetry, backoffMs, RETRYABLE_STATUS, DEFAULT_TIMEOUT_MS, DEFAULT_RETRIES };
