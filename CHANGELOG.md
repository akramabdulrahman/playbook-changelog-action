# Changelog

This action maintains changelogs, so it keeps one. Consumers should pin a commit SHA;
`v1` is a moving pointer and changing it changes their behaviour with no PR on their side.

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
