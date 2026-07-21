# Usage

No command is run day to day. The documents update as a side effect of merging.

---

## What happens, and when

| Event | Mode | Effect |
| --- | --- | --- |
| PR opened, pushed to, reopened, description edited | **preview** | Posts (or updates) one sticky comment showing the exact edits. **Writes nothing.** |
| PR merged | **apply** | Writes both files, commits with `[skip ci]`, pushes to the base branch. |
| PR closed without merging | noop | Nothing. |

Re-pushing updates the *same* comment rather than adding another. Replaying the same merge
event is a no-op — entries dedupe, so a re-run cannot double-write.

## Reading the preview comment

```
### 📓 Docs preview

**`docs/changelog.md`**
+ Sign outbound webhooks with HMAC (#11)

**`docs/playbook.md`**
Under **## Security, Compliance + GDPR**:
+ - Outbound webhooks now include an X-Signature-256 header. ([walkthrough](https://…))

**Walkthrough video**
✅ Walkthrough video: loom.com — this link will be attached to the playbook entry.

Applied automatically when this PR merges. model: `openai/gpt-4o-mini` ·
data sent: metadata only (no file contents) · tokens: 1952 in / 50 out
```

The footer records which model ran, **what data left the runner**, and the token cost.

The comment also carries the decision in a hidden marker. On merge that decision is
**replayed** rather than recomputed, so the commit cannot disagree with what you were shown.
Pushing a new commit invalidates it and a fresh preview is computed.

## Writing PRs that produce good docs

The model receives the pull request **title, description, commit subjects and changed file
paths** — by default not the code itself. The prose in the pull request is the input.

**Good** — states the durable fact and its consequence:

> Session lookups now hit Redis instead of Postgres. Introduces a new `REDIS_URL` env var
> that must be set in every environment before deploy.

**Poor** — nothing durable to extract:

> fixes the thing

A PR that genuinely contains no lasting operational fact (a refactor, a typo, a dependency
bump) is expected to produce a changelog line and **no** playbook entry. That is correct
behaviour, not a failure.

## Walkthrough videos

Suggested, never required. If the PR description contains a link to a recognised host
(Loom, Vimeo, YouTube, Wistia, Descript, Scribe, and others), it is attached to the playbook
entry so each capability keeps its recording:

```markdown
Walkthrough: https://www.loom.com/share/abc123
```

With no link, the entry is still written from the PR — nothing is blocked and nothing is
withheld. Teams that want it enforced can set `video_policy: require`.

## Where entries go

The playbook's headings are a fixed contract. The model is handed your exact heading list
and must pick one; a section that does not exist is **refused** rather than created, so
structure cannot drift between repos. If you see:

> _No change — the model asked for a section this playbook does not define (**Configuration
> & Secrets**), and the structure is fixed._

…then either the fact belongs under an existing heading and the model chose badly, or your
playbook is genuinely missing a section. Add the heading by hand, or set
`allow_new_sections: true` if you want the model to create them.

## The changelog and releases

`docs/changelog.md` holds only what is not yet in a `docs/release-*.md`:

```markdown
# Unreleased

<!-- changelog-base: c1c299f… -->

- Rate limit the public API to 100 requests per minute (#7)
- Send HSTS and nosniff security headers (#8)
```

The hidden marker records the commit the last release was cut at, so "unreleased" means
"since that SHA".

**Cutting a release is manual** — it is your decision when one happens:

```bash
node scripts/make-release.js --title "v1.4.0"
node scripts/make-release.js --title "v1.4.0" --dry-run   # preview first
```

That moves the unreleased entries into `docs/release-YYYY-MM-DD.md`, stamps the range it
covered, empties the changelog and advances the marker. It prints the `git add`/`commit`
commands to run; it does not commit for you.

### Appending to an existing hand-curated release log

If the repo already keeps release notes by hand, write into that file instead of creating a
new one per release:

```bash
node scripts/make-release.js --title "r" \
  --format release-notes --released-by "Dana"
```

It prepends a dated section, newest first, in the format such files already use:

```markdown
## July 21, 2026 (released by Dana)

  - Report export drops the final column [(#960)](https://github.com/o/r/issues/960)
```

The `(#N)` from each changelog entry becomes a link to `/issues/N`; GitHub redirects that to
the pull request when the number is a PR, so one link form covers both. Options:
`--notes-file` (default `docs/release-notes.md`), `--link-base`, `--repo`, `--date`.

To run it from the GitHub UI instead, copy [`examples/release.yml`](../examples/release.yml)
into `.github/workflows/` and use *Actions → Cut release → Run workflow*.

## Keeping the playbook healthy

The action watches for drift and tells you in the PR comment:

- **Similar entry** — a new entry overlapping an existing one is flagged for you to merge
  by hand. A near-identical restatement is skipped entirely.
- **Crowded section** — a section past 12 entries is reported as ready for compaction.
- **Truncation** — once the playbook exceeds `max_playbook_chars` the model only sees part
  of it; you will be told.

None of these block anything. They exist because the failure mode of automated docs is slow
bloat that nobody notices until the file is unreadable. Plan to read the playbook properly
every few months and compact it.

## What the action never does

- Overwrite an existing `docs/playbook.md` or `docs/changelog.md` with a template.
- Reformat a file. Edits splice single lines in; a merge commit is
  `2 files changed, 2 insertions(+)` even on a file with irregular spacing.
- Rewrite or delete an existing entry.
- Push anything during preview.

---

Next: [Configuration](configuration.md) · [Troubleshooting](troubleshooting.md)
