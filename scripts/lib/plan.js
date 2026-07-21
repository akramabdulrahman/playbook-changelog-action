'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { decide } = require('./llm');
const { truncate } = require('./context');
const { checkVideoPolicy, renderVideoSection } = require('./video');
const md = require('./markdown');

const TEMPLATES = path.join(__dirname, '..', '..', 'templates');

function readOrTemplate(filePath, templateName) {
  if (fs.existsSync(filePath)) return { content: fs.readFileSync(filePath, 'utf8'), created: false };
  return { content: fs.readFileSync(path.join(TEMPLATES, templateName), 'utf8'), created: true };
}

/**
 * Compute the docs edits for one change. Pure with respect to the filesystem:
 * reads current docs, returns the new contents without writing them.
 */
async function planEdits({ ctx, docsDir, provider, model, apiKey, maxPlaybookChars, videoHosts, videoPolicy, allowNewSections = false, replayDecision = null }) {
  const playbookPath = path.join(docsDir, 'playbook.md');
  const changelogPath = path.join(docsDir, 'changelog.md');

  const playbook = readOrTemplate(playbookPath, 'playbook.md');
  const changelog = readOrTemplate(changelogPath, 'changelog.md');

  // Replaying the previewed decision keeps the merge faithful to what the comment
  // promised; a fresh call could differ, and the playbook may have moved since.
  const fresh = replayDecision
    ? { decision: replayDecision, usage: {}, model: 'replayed-from-preview', error: null }
    : await decide({
      provider,
      model,
      apiKey,
      ctx,
      playbook: truncate(playbook.content, maxPlaybookChars, 'playbook'),
      allowedSections: md.sectionTitles(playbook.content),
    });
  const { decision, usage, model: usedModel, error } = fresh;

  // Prefer the issue the PR title referenced; the PR number is the fallback.
  const ref = ctx.issueNumber || ctx.number;
  const entry = ref ? `${decision.changelog} (#${ref})` : decision.changelog;
  const clResult = md.insertChangelogEntry(changelog.content, entry);

  const video = checkVideoPolicy({ ctx, hosts: videoHosts, policy: videoPolicy });

  let pbResult = { content: playbook.content, inserted: false, reason: 'skipped' };
  let section = '';
  let sentence = decision.sentence;
  const proposed = decision.section.replace(/^NEW:\s*/i, '').trim();
  // The playbook structure is fixed: refuse a section the template does not define,
  // rather than quietly growing a parallel set of headings.
  const sectionExists = proposed ? md.hasSection(playbook.content, proposed) : false;
  const sectionRejected = Boolean(proposed) && !sectionExists && !allowNewSections;

  // Graded duplicate handling: near-identical is skipped, merely similar is flagged.
  const near = decision.sentence ? md.findNearDuplicate(playbook.content, decision.sentence) : null;
  const isRestatement = Boolean(near && near.score >= 0.85);

  if (decision.durable && !decision.known && decision.sentence && decision.section && !sectionRejected && !isRestatement) {
    section = proposed;
    // Attach the walkthrough so the playbook keeps a video per capability.
    if (video.ok) sentence = `${sentence} ([walkthrough](${video.links[0].url}))`;
    pbResult = md.insertPlaybookEntry(playbook.content, section, sentence);
  } else if (error) {
    // Never report "nothing to add" when the model simply never answered.
    pbResult.reason = 'llm-unavailable';
  } else if (isRestatement) {
    pbResult.reason = 'restates-existing';
  } else if (sectionRejected) {
    pbResult.reason = 'unknown-section';
  } else if (!decision.durable) {
    pbResult.reason = 'not-durable';
  } else if (decision.known) {
    pbResult.reason = 'already-documented';
  } else {
    pbResult.reason = 'no-placement';
  }

  return {
    decision,
    video,
    proposedSection: proposed,
    sectionRejected,
    nearDuplicate: near,
    crowded: md.crowdedSections(playbook.content),
    playbookChars: playbook.content.length,
    maxPlaybookChars,
    usage,
    usedModel,
    llmError: error,
    section,
    changelog: {
      path: changelogPath,
      entry,
      content: clResult.content,
      inserted: clResult.inserted,
      reason: clResult.reason,
      createdFile: changelog.created,
    },
    playbook: {
      path: playbookPath,
      sentence,
      content: pbResult.content,
      inserted: pbResult.inserted,
      reason: pbResult.reason,
      createdFile: playbook.created,
    },
  };
}

function renderPreview(plan, ctx) {
  const lines = ['### 📓 Docs preview', ''];

  lines.push('**`docs/changelog.md`**');
  if (plan.changelog.inserted) lines.push('', '```diff', `+ ${plan.changelog.entry}`, '```');
  else lines.push('', `_No change — ${plan.changelog.reason}._`);
  lines.push('');

  lines.push('**`docs/playbook.md`**');
  if (plan.playbook.inserted) {
    const label = plan.playbook.reason === 'new-section' ? `${plan.section} _(new section)_` : plan.section;
    lines.push('', `Under **## ${label}**:`, '', '```diff', `+ - ${plan.playbook.sentence}`, '```');
  } else {
    const why = {
      'already-documented': 'this is already covered in the playbook',
      'not-durable': 'no durable operational fact in this change',
      'no-placement': 'the model found a fact but no place to put it',
      'restates-existing': `this restates an entry already present — \`${plan.nearDuplicate?.line ?? ''}\``,
      'unknown-section': `the model asked for a section this playbook does not define (**${plan.proposedSection}**), and the structure is fixed`,
      'llm-unavailable': '⚠️ the model call failed, so the playbook was left alone (see below)',
      duplicate: 'that entry already exists',
    }[plan.playbook.reason] || plan.playbook.reason;
    lines.push('', `_No change — ${why}._`);
  }

  lines.push('', '**Walkthrough video**', '', renderVideoSection(plan.video));

  const notes = [];
  if (plan.playbook.inserted && plan.nearDuplicate) {
    notes.push(`⚠️ Similar to an existing entry (${Math.round(plan.nearDuplicate.score * 100)}% overlap): \`${plan.nearDuplicate.line}\` — worth merging by hand.`);
  }
  for (const c of plan.crowded || []) {
    notes.push(`📚 **${c.title}** now holds ${c.count} entries; consider compacting it.`);
  }
  if (plan.playbookChars > plan.maxPlaybookChars) {
    notes.push(`✂️ The playbook (${plan.playbookChars} chars) exceeds \`max_playbook_chars\` (${plan.maxPlaybookChars}); the model sees a truncated copy.`);
  }
  if (notes.length) lines.push('', '**Housekeeping**', '', ...notes.map((n) => `- ${n}`));

  const meta = [`model: \`${plan.usedModel}\``];
  meta.push(ctx.dataScope === 'diff' ? 'data sent: metadata + redacted diff' : 'data sent: metadata only (no file contents)');
  if (ctx.excludedFiles) meta.push(`${ctx.excludedFiles} path(s) excluded by policy`);
  if (plan.usage?.input_tokens != null) meta.push(`tokens: ${plan.usage.input_tokens} in / ${plan.usage.output_tokens} out`);
  if (plan.usage?.prompt_tokens != null) meta.push(`tokens: ${plan.usage.prompt_tokens} in / ${plan.usage.completion_tokens} out`);
  if (ctx.skippedFiles) meta.push(`${ctx.skippedFiles} noise file(s) excluded`);
  if (plan.llmError) meta.push(`⚠️ LLM error, fell back to changelog only: ${plan.llmError}`);

  lines.push('', '---', `<sub>Applied automatically when this PR merges. ${meta.join(' · ')}</sub>`);
  return lines.join('\n');
}

module.exports = { planEdits, renderPreview, readOrTemplate };
