# Troubleshooting

Symptoms, causes and fixes. Every message quoted here is one the action actually emits.

---

## Nothing happens on a PR

**No workflow run at all.** The workflow file must exist on the **default branch** before it
runs on PRs. Check *Actions* for a run; if the tab is empty, merge the workflow first.

**Runs, but no comment.** The job needs `pull-requests: write`. Without it the preview is
printed to the job log instead:

```
::warning::no github_token — printing preview instead of commenting.
```

**PR from a fork.** Fork PRs get a read-only token by default, so the comment is skipped.
Expected on public repos; not a factor for branch-based workflows.

---

## `403` errors

### On push, during apply

```
remote: Permission to OWNER/REPO.git denied to github-actions[bot]
```

The apply job already declares `contents: write` in its `permissions:` block, which normally
grants write even under a read-only repository default. A `403` here means an **organisation
or enterprise policy** is capping the token — flip *Settings → Actions → General → Workflow
permissions* to **Read and write** (or have an org admin lift the policy).

### Creating a follow-up PR

```
403: GitHub Actions is not permitted to create or approve pull requests.
```

Tick *Allow GitHub Actions to create and approve pull requests* in the same settings panel.
The docs commit is already pushed to `docs/playbook-<N>`, so nothing is lost — enable the
setting and re-run, or open that PR by hand.

### Calling GitHub Models

```
github-models 403: …
```

The job is missing `models: read` in its `permissions:` block.

---

## The playbook was not updated

The comment always says why. The reasons, and what to do:

| Message | Meaning | Action |
| --- | --- | --- |
| _no durable operational fact in this change_ | A refactor, typo or bump. | Nothing — correct behaviour. |
| _this is already covered in the playbook_ | The fact is already documented. | Nothing. |
| _this restates an entry already present_ | Near-identical to an existing line. | Nothing; the existing entry stands. |
| _the model asked for a section this playbook does not define_ | It picked a heading you do not have. | Add the heading, or set `allow_new_sections: true`. |
| _⚠️ the model call failed_ | Provider error; changelog still written. | Check the footer for the error, usually quota or auth. |

---

## The model call failed

The footer carries the provider's own message. Common ones:

```
openai 429: You exceeded your current quota
```
Billing, not code. The run degrades to a changelog entry and does not fail your PR.

```
request timed out after 30000ms
```
Already retried twice with backoff. Transient; the next push will retry.

Auth failures (`401`) are **not** retried — a bad key will not fix itself.

---

## Preview and merge disagreed

Should not happen: the decision shown in the comment is stored in it and replayed on merge.
The apply log says which path ran:

```
Replaying the decision shown in the preview comment.
No stored preview decision; recomputing.
```

Recomputing happens when the comment was deleted, or a new commit was pushed after the
preview (the decision is keyed to the head SHA, so a stale one is never reused). If you see
a genuine mismatch with `Replaying`, that is a bug worth reporting.

---

## Two PRs merged at once

Expected and handled:

```
::notice::push rejected (attempt 1/5); rebasing onto origin/main and retrying.
```

The job rebases onto the new tip and pushes again, up to five times. If it exhausts them,
re-run the job — the entry is idempotent, so a re-run cannot double-write.

---

## The docs commit triggered another run

It should not: the message ends with `[skip ci]`. If your CI ignores that convention, add an
explicit guard:

```yaml
if: ${{ !contains(github.event.head_commit.message, '[skip ci]') }}
```

---

## Formatting changed unexpectedly

It should not. Insertion splices single lines into the original file; blank runs, trailing
whitespace and `<details>` markup are preserved. A merge commit should read
`2 files changed, 2 insertions(+)`.

If you see a reformatted file, check whether a human edit landed in the same commit — and
report it, because the test suite asserts no pre-existing line ever changes.

---

## Verifying without GitHub

From a clone of the action repo:

```bash
node --test test/unit.test.js   # unit tests
test/simulate.sh mock           # full PR loop against a local bare repo
```

`simulate.sh` builds a throwaway repo in `/tmp/pbcl-sim`, opens and merges PRs, replays an
event to prove idempotency, exercises the video suggestion and cuts a release. Pass
`github`, `openai` or `anthropic` with the matching credentials to exercise a real provider.

---

Back to: [Installation](installation.md) · [Usage](usage.md) · [Configuration](configuration.md)
