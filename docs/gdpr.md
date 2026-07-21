# GDPR and data handling

Not legal advice. This is what the action does with data, and the questions a DPO will ask.

---

## What actually leaves the runner

With the default `data_scope: metadata`, exactly this:

- the PR title and description
- commit subject lines on the branch
- the list of changed file **paths**
- the current `docs/playbook.md`, so the model can pick a heading

**No file contents.** No source code. Switching to `data_scope: diff` adds a truncated diff
and is an explicit, per-repo decision.

Everything above is passed through a redactor first. Emails, API keys, GitHub/Slack tokens,
JWTs, private keys and connection-string credentials are replaced with `[REDACTED_*]`
before the request is built. Paths matching `exclude_paths` are dropped before a diff is
even read from git.

The preview comment states which mode ran, on every PR:

```
data sent: metadata only (no file contents)
```

## The six questions

**1. Who is processing the data?**
With `llm_provider: github` it is GitHub — already your code host, already in the client's
sub-processor chain, already covered by an existing agreement. Choosing `openai` or
`anthropic` introduces a *new contracting party*, which normally needs the client's
agreement and a DPA.

**2. Is "no new vendor" the same as "no sub-processor"?**
No. GitHub Models runs on Microsoft/Azure infrastructure with model providers underneath.
It avoids a new party *you* contract with; it does not make the processing chain disappear.

**3. Does the client's existing agreement cover it?**
Do not assume so. Authorising GitHub to **host** code is not the same purpose as
authorising it to be **processed by a model**. Purpose limitation is a separate obligation
from transparency — a client knowing about something does not by itself make it lawful.

**4. Is personal data involved?**
PR descriptions routinely contain names and email addresses. Emails are redacted. Author
logins are not sent. Free-text prose may still contain names, which is one more reason the
default scope excludes file contents.

**5. What is retained, and for how long?**
Provider- and plan-dependent. Free tiers generally carry weaker contractual commitments on
retention and training than paid or enterprise ones — the guarantees are part of what paid
plans buy. Confirm the terms for your specific plan before enabling this on client repos.

**6. Is it written down?**
The playbook has a Security, Compliance + GDPR section. Record that this automation runs,
what it sends, to whom, and under which agreement. If the tool that maintains the playbook
is itself undocumented in it, that is a gap.

## Reducing exposure further

```yaml
llm_provider: github          # no new contracting party
data_scope: metadata          # no file contents at all
exclude_paths: 'infra/** *.pem *.key secrets/** **/fixtures/**'
```

For the strictest case, run `llm_provider: mock` — no network call of any kind. You lose
model judgement and keep changelog accumulation, which some teams find is enough on its own.

## What this does not solve

- Whether your client DPAs cover LLM processing. Read them.
- GitHub Models' current retention terms on your plan. Check them.
- Anyone with **write access to a repo can read its secrets** by editing a workflow in
  their own PR. That is GitHub's model, not this action's — but it is a further reason to
  prefer `llm_provider: github`, which needs no API key at all.

---

Back to: [Installation](installation.md) · [Configuration](configuration.md)
