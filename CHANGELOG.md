# Changelog

This action maintains changelogs, so it keeps one. Consumers should pin a commit SHA;
`v1` is a moving pointer and changing it changes their behaviour with no PR on their side.

## v1.1.0 — 2026-07-21

### Fixed

- The Anthropic provider sent `temperature: 0` unconditionally. Sampling parameters were
  removed on Claude Opus 4.7/4.8, Sonnet 5 and Fable 5, which reject them with a 400, so
  those models could not be used at all. The parameter is now sent only to models that
  accept it, with a one-shot retry without it if a provider rejects it anyway.
- The Anthropic default model is expressed as the `claude-haiku-4-5` alias rather than a
  dated snapshot ID.

### Changed

- Documentation rewritten in a neutral, third-person register.
- All three model providers — GitHub Models, Anthropic (Claude) and OpenAI — are now
  documented together, with endpoints, default models, credentials and job permissions.

## v1.0.0 — 2026-07-21

First public release. Developed internally beforehand; that history is not included.

### What it does

- Previews each PR's documentation impact as a sticky comment, and applies it on merge.
- Pins the playbook to its own headings: a section the file does not define is refused
  rather than invented.
- Edits surgically — a merge commit is `2 files changed, 2 insertions(+)` even on a file
  with irregular spacing.
- Replays the previewed decision on merge, so the comment and the commit cannot disagree.
- Sends metadata only by default (no file contents), redacted, with path exclusions.
- Defaults to GitHub Models, so no API key is needed and no new processor is introduced.
- Suggests a walkthrough video and attaches it to the entry; never blocks a merge.
- Cites the issue from a `#N - Title` PR title, falling back to the PR number.
- `scripts/install.js` installs or upgrades it in a repository, pinning a commit SHA.
- `make-release.js` cuts a release, either as a dated file or appended to an existing
  hand-curated release log.
