# API keys and secret handling

This page applies only when `llm_provider` is `anthropic` or `openai`. The default
provider, `github`, authenticates with the workflow's own `GITHUB_TOKEN` and requires no
API key — there is nothing to store, rotate, or leak. Choosing it is the strongest
available control, not a compromise.

---

## Where the key goes

*Settings → Secrets and variables → Actions → **Secrets** tab → New repository secret*

| Name | When |
| --- | --- |
| `ANTHROPIC_API_KEY` | `llm_provider: anthropic` |
| `OPENAI_API_KEY` | `llm_provider: openai` |

Set them at the **organisation** level to avoid a copy per repository, and scope them to
the repositories that need them.

`LLM_PROVIDER` and `LLM_MODEL` are **variables**, not secrets — they are not sensitive, and
storing non-secrets as secrets makes it harder to see what is actually confidential.

Never place a key in the workflow file, in an `env:` literal, in a repository variable, or
in the pull request body. The workflow file is world-readable in a public repository and
readable by every collaborator in a private one.

---

## What the exposure actually is

**Any job that references a secret can read it, and any collaborator who can push a branch
can add such a job.** A contributor with write access can open a pull request that edits
`.github/workflows/playbook.yml` to print the key, and the workflow that runs is the one
from *their* branch. This is GitHub's execution model, not a property of this action.

Two things limit it:

- **Fork pull requests do not receive secrets.** For `pull_request` events raised from a
  fork, GitHub withholds secrets from the run. The exposure is to people who already have
  write access, not to the internet.
- **Registered secrets are masked in logs.** Masking is best-effort against accidental
  echo. It does not stop deliberate exfiltration.

---

## Reducing the blast radius

Ordered by effect.

**1. Use `llm_provider: github`.** No key exists. This removes the entire class of problem
and is the default for that reason.

**2. Use a dedicated, capped key.** If a provider key is required, issue one that is used
by nothing else, holds the minimum scope the provider offers, and carries a hard spend cap.
A key shared with production services turns a documentation tool into a production
incident.

**3. Protect the workflow path.** Require review on `.github/**` via `CODEOWNERS` plus
branch protection. This is what turns "any collaborator" into "any collaborator plus a
reviewer".

**4. Rotate on a schedule and on staff changes.** Rotation is only meaningful if the key's
place of record is known — see the next section.

**5. Consider withholding the key from the preview job.** Both jobs call the model by
default. Passing the key only to the `apply` job halves the number of runs that touch it,
at the cost of preview comments degrading to changelog-only. This is a deliberate trade,
not a recommendation.

---

## Bitwarden

Bitwarden is two products here, and they solve different halves.

### Password Manager — custody

Storing the key in a shared organisation collection gives a single place of record, access
control over who can read it, and an audit trail. This addresses how the key is held and
handed over between people.

It has no runtime role. The key must still be copied into GitHub Actions secrets for the
workflow to use it, and once copied, the exposure described above applies unchanged.

Recommended record for each key: the provider, which repositories or org secret it was
installed into, the spend cap, and the rotation date. Rotation is then: rotate at the
provider, update the Bitwarden item, update the GitHub secret.

### Secrets Manager — runtime injection

Bitwarden Secrets Manager provides a first-party action, `bitwarden/sm-action@v2`, that
fetches secrets during the job rather than storing them in the repository. Secrets are
issued to a **machine account**, which can reach only the secrets assigned to it, and
fetched values are masked in Actions logs.

What it improves: central revocation, per-machine-account scoping, and a real audit trail
of retrieval.

What it does not change: the machine-account access token must itself be stored as a GitHub
Actions secret (commonly `BW_ACCESS_TOKEN`). A contributor who can edit a workflow can
still read whatever that token can reach. The exposure is narrowed and made auditable; it
is not removed.

Bitwarden does not retain access tokens after creation, so the token must be recorded
somewhere safe at the moment it is generated.

**Assessment for this action:** worthwhile if the organisation already runs Secrets Manager
and wants central revocation across many repositories. Not worth adopting solely for this
action — `llm_provider: github` achieves more, with less machinery, by removing the key.

---

## What the action itself does

- The key is read from the input and used only to authenticate the provider request. It is
  never logged, never written to a file, and never included in the pull request comment.
- Content sent to the provider passes through a redactor first. If an API key, token,
  private key or connection-string credential appears in a diff or pull request body, it is
  replaced with `[REDACTED_*]` before the request is built. This protects against a
  committed secret being forwarded to a third party; it is not a substitute for removing
  the secret from the repository.
- `exclude_paths` drops matching files before any diff is read, so paths known to hold
  credentials never reach the redactor in the first place.

---

Related: [Configuration](configuration.md) · [GDPR notes](gdpr.md) · [Installation](installation.md)

Sources for the Bitwarden Secrets Manager behaviour described above:
[GitHub Actions integration](https://bitwarden.com/help/github-actions-integration/) ·
[bitwarden/sm-action](https://github.com/bitwarden/sm-action) ·
[Access tokens](https://bitwarden.com/help/access-tokens/)
