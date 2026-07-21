# Configuration

Every input, what it changes, and when to touch it. All are optional — the defaults are the
intended setup for an internal repo.

---

## Inputs

### Model

| Input | Default | Notes |
| --- | --- | --- |
| `llm_provider` | `mock` | `github` · `anthropic` · `openai` · `mock` |
| `llm_model` | per provider | `openai/gpt-4o-mini` (github), `gpt-4o-mini` (openai), `claude-haiku-4-5-20251001` (anthropic) |
| `anthropic_api_key` | — | required only for `anthropic` |
| `openai_api_key` | — | required only for `openai` |

The action's own default is `mock` so it can never make an external call by accident. The
supplied workflow sets `github` explicitly — that is the intended production setting.

- **`github`** — GitHub Models, authenticated with the job's `GITHUB_TOKEN`. Needs
  `models: read` in the job's `permissions`. No API key, no new contracting party.
- **`mock`** — deterministic keyword routing, no network. For trying the plumbing or CI.
  Not a model; never ship it as a real config.

If a model call fails, returns junk, or no key is set, the run degrades to a changelog-only
entry and says so in the comment. It does not fail your PR.

### What data leaves the runner

| Input | Default | Notes |
| --- | --- | --- |
| `data_scope` | `metadata` | `metadata` = PR title, body, commit subjects, file **paths**. `diff` also sends a truncated diff. |
| `exclude_paths` | — | globs never sent, e.g. `infra/** *.pem secrets/**` |
| `max_diff_chars` | `8000` | only read when `data_scope: diff` |
| `max_playbook_chars` | `16000` | how much of the playbook the model sees |

Everything sent is redacted first: emails, API keys, tokens, JWTs, private keys and
connection-string credentials become `[REDACTED_*]`. `exclude_paths` are dropped before any
diff is read. See [GDPR notes](gdpr.md).

`exclude_paths` glob syntax: `*` matches within a path segment, `**` crosses segments.
`*.pem` matches `key.pem` but not `certs/key.pem`; use `**/*.pem` for that.

### Structure

| Input | Default | Notes |
| --- | --- | --- |
| `allow_new_sections` | `false` | `true` lets the model add headings your playbook lacks |
| `docs_dir` | `docs` | where `playbook.md` and `changelog.md` live |

Leave `allow_new_sections` off unless you want each repo's playbook to diverge. With it off,
an unrecognised section is refused and reported in the comment.

### Walkthrough videos

| Input | Default | Notes |
| --- | --- | --- |
| `video_policy` | `suggest` | `suggest` nudges; `require` fails the check when no link is present |
| `video_hosts` | built-in list | space/comma separated; **replaces** the defaults |

Built-in hosts: `loom.com`, `vimeo.com`, `youtube.com`, `youtu.be`, `wistia.com`,
`vidyard.com`, `descript.com`, `scribehow.com`, `tella.tv`, `veed.io`, `screen.studio`,
`zoom.us`, `drive.google.com`, `claap.io`, `bubbles.video`.

Matching is by host with subdomain support, so `team.loom.com` counts and `notloom.com`
does not. For a self-hosted recorder:

```yaml
video_hosts: 'videos.acme.internal loom.com'   # listing replaces the defaults entirely
```

### Writing back

| Input | Default | Notes |
| --- | --- | --- |
| `apply_mode` | `push` | `pr` opens a follow-up PR instead of pushing — use on protected branches |
| `github_token` | `${{ github.token }}` | needs `contents: write` on the apply job |
| `commit_author_name` | `github-actions[bot]` | |
| `commit_author_email` | `41898282+github-actions[bot]@users.noreply.github.com` | |

`apply_mode: pr` additionally requires *Settings → Actions → General → Allow GitHub Actions
to create and approve pull requests*.

## Outputs

| Output | Value |
| --- | --- |
| `mode` | `preview` · `apply` · `noop` |
| `changed` | `true` when docs were written |
| `video_ok` | `true` when an accepted walkthrough link was found |

## make-release options

| Flag | Default | Notes |
| --- | --- | --- |
| `--title` | required | release title (unused by `release-notes` format) |
| `--format` | `dated-file` | `release-notes` prepends to an existing curated log |
| `--released-by` | — | required for `release-notes` |
| `--notes-file` | `docs/release-notes.md` | target for `release-notes` |
| `--link-base` | from git remote | e.g. `https://github.com/o/r/issues` |
| `--date` | today | `YYYY-MM-DD` |
| `--dry-run` | — | print, write nothing |

---

## Workflow structure

The supplied workflow splits into two jobs, and both details matter.

**Least privilege.** `preview` gets `contents: read`; only `apply` gets `contents: write`.
The job that comments on PRs cannot write to the repo.

**Concurrency.** These groups are not interchangeable:

```yaml
# preview — per PR: a new push supersedes the previous preview
group: playbook-preview-${{ github.event.pull_request.number }}
cancel-in-progress: true

# apply — per BASE BRANCH: two PRs merging at once must not race to push
group: playbook-apply-${{ github.event.pull_request.base.ref }}
cancel-in-progress: false
```

Keying `apply` per PR lets concurrent merges collide. The push does rebase and retry, so
docs are not lost either way, but serialising avoids the churn.

**Triggers.** Keep `edited` in `types:` — an author who adds a walkthrough link after
opening the PR should get the preview recomputed so the link is picked up on merge.

---

## Common setups

**Internal repo, standard** — the shipped defaults. Nothing to change.

**Client repo, strict data handling:**

```yaml
llm_provider: github
data_scope: metadata
exclude_paths: 'infra/** *.pem *.key secrets/** **/fixtures/**'
```

**Repo where the model needs code to be useful** (small, low-sensitivity):

```yaml
data_scope: diff
max_diff_chars: '6000'
exclude_paths: '**/*.env **/secrets/**'
```

Get sign-off before this on client work.

**Protected `main`:**

```yaml
apply_mode: pr
```

**Enforced walkthroughs:**

```yaml
video_policy: require
```

Then make the preview job a required status check in branch protection.

---

Next: [Usage](usage.md) · [Troubleshooting](troubleshooting.md) · [GDPR notes](gdpr.md)
