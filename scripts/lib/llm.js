'use strict';

const { fetchWithRetry } = require('./http');

const DEFAULT_MODELS = {
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  // GitHub Models is OpenAI-compatible and authenticates with the workflow's own
  // GITHUB_TOKEN, so no new vendor and no new secret enter the repo.
  github: 'openai/gpt-4o-mini',
};

const GITHUB_MODELS_ENDPOINT = 'https://models.github.ai/inference/chat/completions';

const SYSTEM = [
  'You maintain a repository playbook. You do NOT rewrite it.',
  'Given the current playbook and one change, fill four INDEPENDENT fields.',
  'Reply with MINIFIED JSON only. No prose, no code fences.',
  '',
  '"changelog": a plain one-line description of the change, imperative, <=100 chars.',
  'ALWAYS fill this, for every change without exception. It describes only WHAT CHANGED.',
  'Never mention your durable/known judgement here. Never prefix it with a label',
  'such as "Not durable:" or "Skipped:". It is a user-facing release note.',
  '',
  '"durable": true only if the change establishes a lasting operational fact —',
  'architecture, build/deploy, config/secrets, runbooks, conventions.',
  'false for bug fixes, refactors, renames, copy tweaks, dependency bumps, test-only changes.',
  '',
  '"known": true only if that fact is ALREADY stated in the playbook above.',
  'If durable is false, set known to false — they are separate questions.',
  '',
  '"section" and "sentence": fill only when durable is true and known is false.',
  'section = an exact existing ## heading, or "NEW:<Title>" if none fit.',
  'sentence = one sentence to add, <=180 chars, no bullet marker.',
  'Otherwise set both to "".',
  '',
  'Schema: {"changelog":"…","durable":<bool>,"known":<bool>,"section":"…","sentence":"…"}',
  'Example (refactor): {"changelog":"Extract greeting into a variable","durable":false,"known":false,"section":"","sentence":""}',
  'Example (new env var): {"changelog":"Add Redis cache to session store","durable":true,"known":false,"section":"Configuration & Secrets","sentence":"Session lookups require REDIS_URL to be set in every environment."}',
].join('\n');

function buildUserPrompt(ctx, playbook, allowedSections = []) {
  return [
    allowedSections.length
      ? `<allowed_sections>\n${allowedSections.map((t) => `- ${t}`).join('\n')}\n</allowed_sections>`
      : '',
    'The "section" field MUST be copied verbatim from allowed_sections above.',
    'Do not invent a section, and do not use a bold label or bullet from inside a section as if it were one.',
    '<playbook>', playbook, '</playbook>',
    '<change>',
    `title: ${ctx.title}`,
    ctx.body ? `body: ${ctx.body}` : '',
    `commits:\n${ctx.commits.map((c) => `- ${c}`).join('\n')}`,
    `files:\n${ctx.files.map((f) => `- ${f}`).join('\n')}`,
    ctx.diff ? '<diff>' : '<no_diff>File contents were not shared. Judge from the title, body, commit subjects and file paths only.</no_diff>',
    ctx.diff || '',
    ctx.diff ? '</diff>' : '',
    '</change>',
  ].filter(Boolean).join('\n');
}

function parseDecision(raw) {
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error(`model returned no JSON object: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  const section = String(parsed.section || '').trim();
  const sentence = String(parsed.sentence || '').trim();
  return {
    // Strip any judgement label the model prefixed despite instructions — this text
    // is committed verbatim to the changelog.
    changelog: String(parsed.changelog || '')
      .replace(/^\s*(not\s+durable|durable|skipped?|no\s+change|n\/a)\s*[:\-–]\s*/i, '')
      .trim(),
    // Older/looser replies omit `durable`; infer it from whether a placement was given.
    durable: parsed.durable === undefined ? Boolean(section && sentence) : parsed.durable === true,
    known: parsed.known === true,
    section,
    sentence,
  };
}

async function callAnthropic({ apiKey, model, system, user }) {
  const res = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      // Preview and apply are separate calls on the same input; sampling would let them
      // disagree, so the comment could promise an edit the merge does not make.
      temperature: 0,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  }, { onRetry: (r) => console.log(`::notice::anthropic retry ${r.attempt + 1}: ${r.status || r.error}, waiting ${r.wait}ms`) });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json();
  const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return { text, usage: json.usage || {} };
}

/**
 * OpenAI-compatible chat completion. Used for both api.openai.com and GitHub Models,
 * which speak the same wire format.
 */
async function callOpenAICompatible({ endpoint, apiKey, model, system, user, label }) {
  const res = await fetchWithRetry(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 400,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  }, { onRetry: (r) => console.log(`::notice::${label} retry ${r.attempt + 1}: ${r.status || r.error}, waiting ${r.wait}ms`) });
  if (!res.ok) throw new Error(`${label} ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return { text: json.choices?.[0]?.message?.content || '', usage: json.usage || {} };
}

const callOpenAI = (args) => callOpenAICompatible({ ...args, endpoint: 'https://api.openai.com/v1/chat/completions', label: 'openai' });
const callGitHubModels = (args) => callOpenAICompatible({ ...args, endpoint: GITHUB_MODELS_ENDPOINT, label: 'github-models' });

/** Deterministic stand-in so the whole loop can be exercised without an API key. */
function callMock(ctx, playbook) {
  const hay = `${ctx.title}\n${ctx.body}\n${ctx.files.join('\n')}\n${ctx.diff}`.toLowerCase();
  // Section names track the PM playbook template. The real providers read the headings
  // out of the live document; this list only keeps `mock` runs plausible.
  const rules = [
    [/\b(gdpr|security|encrypt|compliance|privacy|vulnerab)\b/, 'Security, Compliance + GDPR'],
    [/\b(integration|webhook|zendesk|sendgrid|third[- ]party|external api)\b/, 'External integrations'],
    [/\b(role|permission|admin|access control|rbac)\b/, 'User Roles'],
    [/\b(error|troubleshoot|failure|retry|fallback)\b/, 'Troubleshooting'],
    [/\b(login|signup|onboard|getting started|setup|install|requirement)\b/, 'Getting Started'],
    [/\b(env|secret|api[_-]?key|token|credential|config|deploy|docker|ci|pipeline|build)\b/, 'Product Design and Development'],
    [/\b(dashboard|nav|menu|page|screen)\b/, 'Navigating the tool\/website'],
  ];
  const section = (rules.find(([re]) => re.test(hay)) || [null, 'Key Features'])[1];
  const sentence = `${ctx.title.replace(/\.$/, '')} (see PR #${ctx.number}).`;
  const known = playbook.toLowerCase().includes(ctx.title.toLowerCase());
  const durable = !/\b(refactor|rename|typo|tidy|cleanup|bump|format)\b/.test(hay);
  const place = durable && !known;
  return {
    text: JSON.stringify({ changelog: ctx.title, durable, known, section: place ? section : '', sentence: place ? sentence : '' }),
    usage: { input_tokens: 0, output_tokens: 0, mock: true },
  };
}

/** Ask the model where this change belongs. Never throws — falls back to changelog-only. */
async function decide({ provider, model, apiKey, ctx, playbook, allowedSections }) {
  const system = SYSTEM;
  const user = buildUserPrompt(ctx, playbook, allowedSections);
  const chosenModel = model || DEFAULT_MODELS[provider] || '';

  let result;
  try {
    if (provider === 'anthropic') result = await callAnthropic({ apiKey, model: chosenModel, system, user });
    else if (provider === 'openai') result = await callOpenAI({ apiKey, model: chosenModel, system, user });
    else if (provider === 'github') result = await callGitHubModels({ apiKey, model: chosenModel, system, user });
    else result = callMock(ctx, playbook);

    const decision = parseDecision(result.text);
    if (!decision.changelog) decision.changelog = ctx.title;
    return { decision, usage: result.usage, model: chosenModel || 'mock', error: null };
  } catch (err) {
    return {
      decision: { changelog: ctx.title, durable: false, known: false, section: '', sentence: '' },
      usage: {},
      model: chosenModel || 'mock',
      error: err.message,
    };
  }
}

module.exports = { decide, parseDecision, buildUserPrompt, DEFAULT_MODELS, GITHUB_MODELS_ENDPOINT, SYSTEM };
