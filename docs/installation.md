# Installation

Adding this to a repository is one workflow file and two repository variables. There is
nothing to install locally, no `docs/` files to create, and no API key in the common case.

**Time:** about five minutes.
**Result:** every PR previews its documentation impact; every merge applies it.

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

## Step 1 — Allow the workflow to write

*Settings → Actions → General → Workflow permissions*

Select **Read and write permissions**.

The merge job commits the updated docs back to the branch you merged into. Without this it
will fail with a `403` on push.

> If you plan to use `apply_mode: pr` (see [Protected branches](#step-5--protected-branches)),
> also tick **Allow GitHub Actions to create and approve pull requests** in the same panel.

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

Set `LLM_PROVIDER` to `openai` or `anthropic`, then add the matching **secret**
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) under the *Secrets* tab.

Be aware this introduces a new data processor. Read [GDPR notes](gdpr.md) before doing this
on a client repository.

</details>

## The quick way: the installer

Run this inside the repo you want to install into — no clone, no global install:

```bash
npx github:akramabdulrahman/playbook-changelog-action-public playbook-install
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
- uses: akramabdulrahman/playbook-changelog-action-public@258bc2c56872bef56c2c55da54115e8eec008f4b # v1.0.0
```

**Pin the SHA, not `@v1`.** `v1` is a moving pointer: whoever owns the action can repoint
it, and your repo's behaviour changes with no PR and no notice on your side. The SHA is
immutable. Update it deliberately, reading [CHANGELOG.md](../CHANGELOG.md) as you go.

Find the commit SHA for a release with:

```bash
git rev-parse v1.0.0^{}   # note the ^{} — without it you get the tag object, not the commit
```

Commit the workflow to your default branch. It has to exist there before it will run on PRs.

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
