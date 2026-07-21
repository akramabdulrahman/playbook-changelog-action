#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { git, buildContext } = require('./lib/context');
const { planEdits, renderPreview } = require('./lib/plan');
const { upsertStickyComment, createPullRequest, findPreviewedDecision, encodeDecision } = require('./lib/github');
const { parseHosts } = require('./lib/video');

function input(name, fallback = '') {
  const v = process.env[`INPUT_${name.toUpperCase()}`];
  return v === undefined || v === '' ? fallback : v;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

function summary(text) {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
}

function loadEvent() {
  const p = process.env.GITHUB_EVENT_PATH;
  if (!p || !fs.existsSync(p)) throw new Error('GITHUB_EVENT_PATH missing — this action expects a pull_request event.');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * Someone who pastes only the Marketplace `uses:` snippet gets no triggers and no
 * checkout, and the failure is otherwise cryptic (empty workspace, git errors, or the
 * job simply never running). Detect the two misconfigurations we can see from inside a
 * run and say exactly what is missing, pointing at the installer that writes it correctly.
 */
function preflight(event) {
  const problems = [];

  if (event.pull_request === undefined) {
    problems.push(
      `This action must be triggered by a "pull_request" event, but it ran on `
      + `"${process.env.GITHUB_EVENT_NAME || 'an unknown event'}". The workflow needs:\n`
      + '      on:\n        pull_request:\n          types: [opened, synchronize, reopened, edited, closed]',
    );
  }

  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
  if (!fs.existsSync(path.join(workspace, '.git'))) {
    problems.push(
      'The repository is not checked out. Add a checkout step *before* this action:\n'
      + '      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0',
    );
  }

  if (problems.length) {
    console.log('::error::playbook-changelog-action is not wired into a complete workflow.');
    for (const p of problems) console.log(`::error::${p}`);
    console.log(
      '::error::The Marketplace snippet is only the step, not a workflow. Generate the '
      + 'full workflow with:  npx github:akramabdulrahman/playbook-changelog-action playbook-install',
    );
    process.exit(1);
  }
}

function resolveMode(event) {
  const pr = event.pull_request;
  if (!pr) return 'noop';
  if (event.action === 'closed') return pr.merged ? 'apply' : 'noop';
  if (['opened', 'synchronize', 'reopened', 'edited', 'ready_for_review'].includes(event.action)) return 'preview';
  return 'noop';
}

async function main() {
  const event = loadEvent();
  preflight(event);
  const mode = resolveMode(event);
  setOutput('mode', mode);

  if (mode === 'noop') {
    console.log(`No action for event "${event.action}" (PR not merged, or not a PR event).`);
    setOutput('changed', 'false');
    return;
  }

  const repo = process.env.GITHUB_REPOSITORY;
  const token = input('github_token');
  const provider = input('llm_provider', 'mock').toLowerCase();
  // 'github' authenticates with the workflow's own token — no new vendor, no new secret.
  const apiKey = provider === 'anthropic' ? input('anthropic_api_key')
    : provider === 'github' ? token
      : input('openai_api_key');
  const docsDir = path.resolve(process.env.GITHUB_WORKSPACE || process.cwd(), input('docs_dir', 'docs'));
  const baseRef = event.pull_request.base.ref;

  if (provider === 'github' && !token) {
    console.log('::warning::llm_provider=github needs a token with `models: read` permission on the job.');
  }
  if (provider !== 'mock' && !apiKey) {
    console.log(`::warning::llm_provider=${provider} but no API key supplied; falling back to changelog-only output.`);
  }

  // In apply mode the merge already landed on the base branch — work from there,
  // not from the PR merge ref (which no longer resolves once the PR is closed).
  // No --depth here: it would shallow-convert the full clone checkout@v4 gave us.
  git(['fetch', '--no-tags', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], { tolerant: true });
  if (mode === 'apply') {
    git(['checkout', '-B', baseRef, `origin/${baseRef}`]);
  }

  const range = mode === 'apply'
    ? `${event.pull_request.base.sha}...${event.pull_request.merge_commit_sha || 'HEAD'}`
    : `origin/${baseRef}...HEAD`;

  const ctx = buildContext({
    event,
    range,
    maxDiffChars: Number(input('max_diff_chars', '8000')),
    dataScope: input('data_scope', 'metadata'),
    excludePaths: input('exclude_paths'),
  });

  // On merge, prefer the decision the PR comment already showed.
  const replayDecision = mode === 'apply' && token
    ? await findPreviewedDecision({ token, repo, issueNumber: event.pull_request.number, headSha: event.pull_request.head.sha })
    : null;
  if (mode === 'apply') {
    console.log(replayDecision ? 'Replaying the decision shown in the preview comment.' : 'No stored preview decision; recomputing.');
  }

  const plan = await planEdits({
    ctx,
    docsDir,
    provider,
    model: input('llm_model'),
    apiKey,
    maxPlaybookChars: Number(input('max_playbook_chars', '16000')),
    videoHosts: parseHosts(input('video_hosts')),
    videoPolicy: input('video_policy', 'suggest'),
    allowNewSections: input('allow_new_sections', 'false') === 'true',
    replayDecision,
  });

  const body = renderPreview(plan, ctx);
  summary(body);


  if (mode === 'preview') {
    if (!token) { console.log('::warning::no github_token — printing preview instead of commenting.'); console.log(body); }
    else {
      const r = await upsertStickyComment({
        token,
        repo,
        issueNumber: event.pull_request.number,
        body: body + encodeDecision(plan.decision, event.pull_request.head.sha),
      });
      console.log(`Preview comment ${r.action} (id ${r.id}).`);
    }
    setOutput('changed', 'false');
    setOutput('video_ok', String(plan.video.ok));

    // Only the opt-in 'require' policy fails the run; the default just suggests.
    if (plan.video.required && !plan.video.ok) {
      console.log('::error::video_policy=require and this PR links no walkthrough video.');
      process.exit(1);
    }
    return;
  }

  // apply
  const wrote = [];
  fs.mkdirSync(docsDir, { recursive: true });
  for (const f of [plan.changelog, plan.playbook]) {
    if (f.inserted || f.createdFile) { fs.writeFileSync(f.path, f.content); wrote.push(f.path); }
  }

  if (!wrote.length) {
    console.log('Nothing to write.');
    setOutput('changed', 'false');
    return;
  }

  git(['config', 'user.name', input('commit_author_name', 'github-actions[bot]')]);
  git(['config', 'user.email', input('commit_author_email', '41898282+github-actions[bot]@users.noreply.github.com')]);
  git(['add', ...wrote]);

  if (!git(['status', '--porcelain', '--', ...wrote], { tolerant: true })) {
    console.log('Docs already up to date — no commit needed.');
    setOutput('changed', 'false');
    return;
  }

  const msg = `docs: update playbook and changelog for #${ctx.number} [skip ci]`;
  git(['commit', '-m', msg]);

  if (input('apply_mode', 'push') === 'pr') {
    const branch = `docs/playbook-${ctx.number}`;
    git(['branch', '-f', branch]);
    git(['push', 'origin', `${branch}:${branch}`, '--force']);
    try {
      const pr = await createPullRequest({
        token, repo, head: branch, base: baseRef,
        title: `docs: playbook & changelog for #${ctx.number}`,
        body: `Automated docs update for #${ctx.number}.\n\n${body}`,
      });
      console.log(`Opened follow-up PR ${pr.html_url}`);
    } catch (err) {
      if (/not permitted to create or approve pull requests/i.test(err.message)) {
        throw new Error(
          'apply_mode: pr needs "Allow GitHub Actions to create and approve pull requests" '
          + `(Settings → Actions → General → Workflow permissions). The docs commit is pushed to branch "${branch}"; `
          + 'enable the setting and re-run, or open the PR by hand.',
        );
      }
      throw err;
    }
  } else {
    pushWithRetry(baseRef);
  }

  setOutput('changed', 'true');
}

/**
 * Two PRs merging at once produce two apply jobs racing to push. The loser used to
 * fail outright and silently lose that PR's docs, so rebase onto the new tip and retry.
 */
function pushWithRetry(baseRef, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    try {
      git(['push', 'origin', `HEAD:${baseRef}`]);
      console.log(`Pushed docs commit to ${baseRef}.`);
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      console.log(`::notice::push rejected (attempt ${i + 1}/${attempts}); rebasing onto origin/${baseRef} and retrying.`);
      git(['fetch', '--no-tags', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], { tolerant: true });
      try {
        git(['rebase', `origin/${baseRef}`]);
      } catch (rebaseErr) {
        // A docs conflict means another job wrote the same lines; take theirs and
        // re-apply this entry on top rather than aborting the run.
        git(['rebase', '--abort'], { tolerant: true });
        throw new Error(`could not rebase docs commit onto ${baseRef}: ${rebaseErr.message}`);
      }
    }
  }
}

main().catch((err) => {
  console.log(`::error::${err.message}`);
  process.exit(1);
});
