# playbook-changelog-action

Self-maintaining `docs/playbook.md` and `docs/changelog.md`. Every PR previews its
documentation impact as a sticky comment; every merge applies it. Nobody runs a script.

```
PR opened  ──▶  📓 preview comment   (writes nothing)
PR merged  ──▶  docs commit pushed   ([skip ci])
you decide ──▶  make-release.js      (rolls the changelog into a dated file)
```

---

## Documentation

| | |
| --- | --- |
| **[Installation](docs/installation.md)** | Five-minute setup: one workflow file, two variables |
| **[Usage](docs/usage.md)** | What happens on each event, writing PRs that produce good docs, cutting releases |
| **[Configuration](docs/configuration.md)** | Every input, with the setups worth copying |
| **[Troubleshooting](docs/troubleshooting.md)** | Symptoms, causes, fixes |
| **[GDPR notes](docs/gdpr.md)** | What leaves the runner, and the questions a DPO will ask |
| **[Changelog](CHANGELOG.md)** | Releases. Pin a commit SHA, not `@v1`. |

## Install

From inside the repository you want to install into:

```bash
npx github:akramabdulrahman/playbook-changelog-action playbook-install
```

It pins the newest release by commit SHA, writes the workflow, and prints the two settings
you need to change. `--dry-run` first if you prefer. Full walkthrough:
[docs/installation.md](docs/installation.md).

## Install, in short

```yaml
# .github/workflows/playbook.yml — see examples/playbook.yml for the full file
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: akramabdulrahman/playbook-changelog-action@1d090cefa47004db0a8ff4caacaf0029c6f5d02b # v1.0.4
  with:
    llm_provider: github     # GitHub Models — no API key needed
    data_scope: metadata     # no file contents leave the runner
```

Set repository **variable** `LLM_PROVIDER=github`, give the job `models: read`, and allow
Actions to write. That is the whole install — `docs/playbook.md` and `docs/changelog.md` are
created from templates on the first merge.

## How it works

The model is never asked to rewrite the playbook. It receives the current playbook, the
list of its exact headings, and a compact description of the change, then answers one small
JSON question: is this a durable fact, is it already documented, which existing heading does
it belong under, and what single sentence should be added. The scripts do the markdown
surgery deterministically — insert, dedupe, replace placeholder.

That keeps it cheap (a few hundred to ~2k input tokens per PR on a small model) and keeps
the file structure under code control rather than model discretion.

**Design commitments**, each enforced by tests:

- **Your file is the contract.** An existing `docs/playbook.md` is never overwritten, and a
  heading the file does not define is refused rather than created.
- **Edits are surgical.** Single lines are spliced in; spacing, trailing whitespace and
  `<details>` markup are preserved. A merge commit reads `2 files changed, 2 insertions(+)`.
- **The preview is binding.** The decision shown in the comment is replayed on merge, so
  the commit cannot disagree with what you were shown.
- **Data is bounded.** Metadata only by default, redacted, with path exclusions.
- **Nothing blocks a merge.** Model failures degrade to a changelog entry and say so.

## Development

```bash
node --test test/unit.test.js   # 56 tests
test/simulate.sh mock           # full PR loop against a local bare repo, no network
```

`simulate.sh` builds a throwaway repo, opens and merges PRs, replays an event to prove
idempotency, exercises the video suggestion and cuts a release.

## Known limits

- The `anthropic` provider path is implemented but has never been exercised against the
  live API.
- Cross-repo `uses:` needs the action repo to be public or org-shared; a private action repo
  on a personal account cannot be consumed by other repos. See
  [installation](docs/installation.md#appendix-private-action-repos).
- Playbooks accrete. The action flags near-duplicates and crowded sections, but expect to
  read and compact the file every few months.
