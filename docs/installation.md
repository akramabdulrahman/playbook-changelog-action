# Installation

Adding this to a repository is one workflow file and two repository variables. In the common case there is
nothing to install locally and no API key; an existing `docs/playbook.md` is used as-is,
or one is created from a template on first run.

**Time:** about five minutes.
**Result:** every PR previews its documentation impact; every merge applies it.

---

## Arriving from the Marketplace?

The listing shows a single step:

```yaml
- uses: akramabdulrahman/playbook-changelog-action@v1.1.5
```

That is GitHub's generic reference for any action — **it is not a runnable workflow for this
one.** This action needs its own workflow: `pull_request` triggers, an `actions/checkout`
step before it, and a preview/apply job pair. Pasted as a bare step it never triggers, or
fails with a clear error telling you what is missing. Run the installer below (or copy
[`examples/playbook.yml`](../examples/playbook.yml)); do not paste the one-line snippet.

## Quickstart

The whole flow, for a repository that already has a `docs/playbook.md` (or any markdown file
to use as one). The step-by-step sections below expand on each part.

```bash
# 1. Install the workflow on a branch
cd /path/to/your-repo
git checkout -b ci/playbook
npx github:akramabdulrahman/playbook-changelog-action playbook-install

# 2. Add your playbook (left exactly as-is; the action reads its headings as the contract)
mkdir -p docs
cp /path/to/your-playbook.md docs/playbook.md      # skip if docs/playbook.md already exists

# 3. Commit and open the install PR
git add .github/workflows/playbook.yml docs/playbook.md
git commit -m "ci: self-maintaining playbook and changelog"
git push -u origin ci/playbook
gh pr create --fill && gh pr merge --merge
```

Settings, in the common case: **none.** The workflow declares its own permissions
(`contents: write` on the merge job, `models: read` on both), which GitHub honours even when
the repository default is read-only — so there is nothing to toggle. The provider defaults
to GitHub Models, so no key or variable is needed either.

Two situations do require a setting, covered below: an organisation that *enforces* a
restrictive token policy ([Step 1](#step-1--permissions-what-you-usually-do-not-need)), and
`apply_mode: pr` on a protected branch ([Step 5](#step-5--protected-branches)).

> **The install PR shows no preview comment — this is expected.** A workflow only triggers
> on pull requests once it exists on the default branch, and on the PR that *adds* it, it
> does not yet. Merge the install PR anyway. Your **next** pull request is the first one the
> action sees: it posts the preview, and merging it writes the entry.

`docs/changelog.md` does not need to be added by hand — it is created from a template on the
first merge that produces an entry.

---

## Before you start

You need:

- **Admin on the repo** (to set variables and, once, a workflow permission).
- **The action available to your repo.** Cross-repo `uses:` only resolves if the action
  repository is public, or private *within the same org* with
  *Settings → Actions → General → Access* set to allow it. A private action repo on a
  personal account cannot be consumed by another repo — see
  [Appendix: private action repos](#appendix-private-action-repos).

You do **not** need an OpenAI or Anthropic account. The default provider is GitHub Models,
which authenticates with the workflow's own token.

---

## Step 1 — Permissions (what you usually do *not* need)

The workflow the installer writes declares its own token permissions per job — `contents:
write` on the merge job, `pull-requests: write` and `models: read` on both. GitHub honours a
workflow's explicit `permissions:` block **even when the repository default is read-only**,
because that default only applies to workflows that declare nothing. So in the common case
there is nothing to change here.

Flip *Settings → Actions → General → Workflow permissions* to **Read and write** only if the
merge job fails with a `403` on push — which happens when an **organisation or enterprise
policy** caps the token below what the workflow requests. On a normal repository it is not
needed.

> `apply_mode: pr` is different: creating a pull request needs *Allow GitHub Actions to
> create and approve pull requests* in the same panel, and no workflow `permissions:` block
> can substitute for it. See [Protected branches](#step-5--protected-branches).

## Step 2 — Set the provider

*Settings → Secrets and variables → Actions → **Variables** tab → New repository variable*

| Name | Value |
| --- | --- |
| `LLM_PROVIDER` | `github` |

These are **variables**, not secrets — `github` is not sensitive, and storing non-secrets
as secrets makes it harder to see what is actually confidential.

Optionally add `LLM_MODEL` to override the default (`openai/gpt-4o-mini`).

Set them at the **organisation** level instead and every repo inherits them; each repo then
needs only the workflow file from step 3.

<details>
<summary>Using OpenAI or Anthropic instead</summary>

Set `LLM_PROVIDER` to `openai` or `anthropic`, then add the matching **secret** —
`OPENAI_API_KEY` or `ANTHROPIC_API_KEY` — under *Settings → Secrets and variables →
Actions → Secrets*. Organisation-level secrets avoid a copy per repository.

Two things to read first: [API keys](secrets.md) covers what the exposure is and how to
narrow it (dedicated capped key, `CODEOWNERS` on `.github/**`, and where Bitwarden does and
does not help), and [GDPR notes](gdpr.md) covers the new data processor this introduces on
a client repository.

</details>

## Installing without a terminal

The installer is a convenience, not a requirement — everything it does can be done from the
GitHub web UI.

**One repository, by hand.** Create `.github/workflows/playbook.yml` with *Add file →
Create new file*, paste the contents of [`examples/playbook.yml`](../examples/playbook.yml),
replace the two `uses:` lines with `akramabdulrahman/playbook-changelog-action@<sha>` (the
SHA of the [latest release](https://github.com/akramabdulrahman/playbook-changelog-action/releases)), and commit. `docs/playbook.md` and
`docs/changelog.md` are created automatically on the first merge.

**Every repository in an organisation, one click.** Publish the files in
[`workflow-templates/`](../workflow-templates/) into your organisation's `.github`
repository — a one-time, in-browser step described in that directory's README. Afterwards,
any repository in the organisation gets a **Playbook & Changelog** entry under *Actions →
New workflow* that creates the workflow file in the browser. This is the closest thing to
"add it without leaving GitHub", and the right choice for rolling it across many repos.

Neither path needs the terminal. The installer below simply automates the first one and
pins the SHA for you.

## The quick way: the installer

Run this inside the repo you want to install into — no clone, no global install:

```bash
npx github:akramabdulrahman/playbook-changelog-action playbook-install
```

Or from a local clone of the action:

```bash
node /path/to/playbook-changelog-action/scripts/install.js
```

It detects the repo and its owner, pins the newest release by **commit SHA**, writes
`.github/workflows/playbook.yml`, and prints the settings you still need to change. If the
action is private and under a different owner it vendors it automatically, because GitHub
cannot resolve that case.

| Flag | Effect |
| --- | --- |
| `--dry-run` | print what would change, write nothing |
| `--upgrade` | re-pin an existing install to the newest release |
| `--vendor` / `--no-vendor` | force vendoring on or off |
| `--ref v1.0.2` | pin a specific release |
| `--exclude-paths '...'` | set `exclude_paths` for this repo |

It never commits, never pushes, and never changes repository settings.

The manual steps below are what the installer automates — follow them if you would rather
see every change yourself.

## Step 3 — Add the workflow

Copy [`examples/playbook.yml`](../examples/playbook.yml) to `.github/workflows/playbook.yml`
and replace the two `uses:` lines with your action repo and a **commit SHA**:

```yaml
- uses: akramabdulrahman/playbook-changelog-action@fcb60e6c7c9f322fbeb6833fa98fba587548d82d # v1.1.5
```

**Pin the SHA, not `@v1`.** `v1` is a moving pointer: whoever owns the action can repoint
it, and your repo's behaviour changes with no PR and no notice on your side. The SHA is
immutable. Update it deliberately, reading [CHANGELOG.md](../CHANGELOG.md) as you go.

Find the commit SHA for a release with:

```bash
git rev-parse v1.1.5^{}   # note the ^{} — without it you get the tag object, not the commit
```

Commit the workflow to your default branch. It has to exist there before it runs on any pull
request — so the PR that *adds* it produces no preview comment. That is expected (see the
Quickstart note above); the first PR opened *after* the merge is the one the action previews.

## Step 4 — Open a test PR

```bash
git checkout -b test/playbook
echo "// test" >> src/anything.js
git commit -am "chore: test the playbook action"
git push -u origin test/playbook
gh pr create --title "Test the playbook action" --body "Checking the docs preview appears."
```

Within a minute a **📓 Docs preview** comment should appear on the PR showing the changelog
line and playbook entry it would add. Nothing has been written to the repo yet.

Merge it. A second run commits `docs: update playbook and changelog for #N [skip ci]` to your
base branch, creating `docs/playbook.md` and `docs/changelog.md` from templates on this first
run.

If nothing happens, see [Troubleshooting](troubleshooting.md).

## Step 5 — Protected branches

If your base branch requires reviews or status checks, the bot's direct push will be
rejected. Switch the apply job to open a PR instead:

```yaml
apply_mode: pr
```

This also needs *Allow GitHub Actions to create and approve pull requests* from step 1.
Without it the run fails with:

```
403: GitHub Actions is not permitted to create or approve pull requests.
```

The docs commit is still pushed to a `docs/playbook-<N>` branch when this happens, so no
work is lost — enable the setting and re-run, or open the PR by hand.

---

## Bringing your own playbook

If `docs/playbook.md` already exists it is **never overwritten** — the bundled template is
only used to create the file when it is missing. Your existing structure becomes the
contract: the model is given your exact headings and must target one of them.

To adopt the standard structure, copy [`templates/playbook.md`](../templates/playbook.md)
into `docs/playbook.md`, fill in the placeholders, and commit before the first merge.

Headings are recognised in all of these forms, so collapsible sections still work:

```markdown
## Section Title
<h2>Section Title</h2>
<details><summary><h3>Section Title</h3></summary>
```

---

## Appendix: private action repos

GitHub resolves `uses:` on the runner with a token scoped to the **calling** repo. That
means a private action repo on a personal account cannot be used by another repo, however
you are authenticated locally.

Options:

1. **Organisation** — keep the action private and enable
   *Settings → Actions → General → Access* on the action repo. This is the normal setup.
2. **Public action repo** — the contents are generic tooling with no secrets.
3. **Vendor it** — copy `action.yml`, `scripts/` and `templates/` into
   `.github/actions/playbook/` in the consuming repo and use `uses: ./.github/actions/playbook`.
   Works anywhere, but you must re-sync on every upgrade, and a PR author can edit the
   vendored scripts, which run with the job's permissions. Prefer options 1 or 2.

---

Next: [Usage](usage.md) · [Configuration](configuration.md) · [GDPR notes](gdpr.md)
