# playbook-changelog-action

A GitHub Action that keeps `docs/playbook.md` and `docs/changelog.md` current. Each pull
request receives a comment previewing the documentation it would add; merging applies it.

```
PR opened  ──▶  preview comment    (nothing is written)
PR merged  ──▶  docs commit        (pushed with [skip ci])
on demand  ──▶  make-release.js    (rolls the changelog into a release)
```

## Documentation

| | |
| --- | --- |
| **[Installation](docs/installation.md)** | Setup: one workflow file and two repository variables |
| **[Usage](docs/usage.md)** | Behaviour per event, writing PRs, cutting releases |
| **[Configuration](docs/configuration.md)** | Every input, with worked examples |
| **[Troubleshooting](docs/troubleshooting.md)** | Symptoms, causes, fixes |
| **[API keys](docs/secrets.md)** | Where keys go, what the exposure is, and how to narrow it |
| **[GDPR notes](docs/gdpr.md)** | What leaves the runner, and under whose agreement |
| **[Changelog](CHANGELOG.md)** | Releases. Pin a commit SHA rather than a tag. |

## Install

Run inside the repository to be configured:

```bash
npx github:akramabdulrahman/playbook-changelog-action playbook-install
```

The installer detects the repository, pins the latest release by commit SHA, writes the
workflow, and prints the remaining settings. `--dry-run` shows the changes without writing
them.

Prefer not to touch a terminal? The action can also be added entirely from the GitHub web
UI — by creating the workflow file in the browser, or, for an organisation, as a one-click
*Actions → New workflow* template. See [installing without a terminal](docs/installation.md#installing-without-a-terminal).

For the end-to-end walkthrough — install, add an existing playbook, and the first-PR
behaviour to expect — see the [Quickstart](docs/installation.md#quickstart). The manual,
step-by-step equivalent is in the same [installation guide](docs/installation.md).

## Model providers

Three providers are supported. All three answer the same structured question and produce
the same kind of result; they differ in who processes the data and what credentials are
required.

| Provider | `llm_provider` | Default model | Credential |
| --- | --- | --- | --- |
| **GitHub Models** | `github` | `openai/gpt-4o-mini` | none — uses the job's `GITHUB_TOKEN` |
| **Anthropic (Claude)** | `anthropic` | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| **OpenAI** | `openai` | `gpt-4o-mini` | `OPENAI_API_KEY` |

A fourth value, `mock`, resolves sections by keyword and makes no network call. It exists
for tests and for trying the workflow without a provider; it is not a model.

**GitHub Models is the default.** It requires `models: read` on the job, introduces no
processor beyond GitHub, and needs no API key — so there is no key to store or leak. The
other two providers accept any model their API exposes via `llm_model`; for Anthropic that
includes `claude-opus-4-8` and `claude-sonnet-5` alongside the Haiku default, and they
require a repository or organisation secret — see [API keys](docs/secrets.md) for where it
goes and what the exposure is.

Whichever provider runs, a failed call degrades to a changelog entry and reports the
failure in the comment rather than failing the pull request.

## How it works

The model does not rewrite the playbook. It receives the current playbook, the list of its
headings, and a compact description of the change, then answers one structured question:
whether the change records a durable fact, whether that fact is already documented, which
existing heading it belongs under, and what single sentence to add. The scripts perform the
markdown edit deterministically.

This keeps cost low — a few hundred to roughly two thousand input tokens per pull request
on a small model — and keeps document structure under code control rather than model
discretion.

Four properties hold, each covered by tests:

- **The existing file is authoritative.** An existing `docs/playbook.md` is never
  overwritten, and a heading the file does not define is refused rather than created.
- **Edits are surgical.** Single lines are spliced in; spacing, trailing whitespace and
  collapsible `<details>` markup are preserved. A merge commit reads
  `2 files changed, 2 insertions(+)`.
- **The preview is binding.** The decision shown in the comment is stored in it and
  replayed on merge, so the commit matches what was displayed.
- **Outbound data is bounded.** Metadata only by default, redacted, with path exclusions.

## Development

```bash
node --test test/unit.test.js test/docs.test.js
test/simulate.sh mock
```

`simulate.sh` builds a temporary repository, opens and merges pull requests, replays an
event to confirm idempotency, exercises the video suggestion, and cuts a release.

## Limitations

- The `anthropic` provider is implemented and unit-tested but has not been exercised
  against the live API.
- Playbooks accumulate entries. The action flags near-duplicates and crowded sections;
  periodic manual compaction is still expected.
