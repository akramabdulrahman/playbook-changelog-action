# Organisation workflow templates

These files let anyone add the action to a repository **entirely from the GitHub web UI** —
the *Actions → New workflow* page gains a one-click **Playbook & Changelog** entry.

## Installing the template (once per organisation, in the browser)

1. Create a repository named **`.github`** in your organisation (or personal account) if one
   does not already exist. It can be public or private.
2. In it, create the directory **`workflow-templates/`**.
3. Add both files from here into that directory, unchanged:
   - `playbook.yml`
   - `playbook.properties.json`
4. Commit.

All four steps are doable with *Add file → Create new file* in the web editor — no clone,
no terminal.

## Using it (per repository, in the browser)

In any repository owned by that organisation:

1. **Actions → New workflow.**
2. Under the organisation's templates, choose **Playbook & Changelog**.
3. GitHub opens the workflow in the web editor. Commit it (directly or via a pull request).

That is the whole install. `docs/playbook.md` and `docs/changelog.md` are created from
templates on the first merge, so nothing else needs to be added by hand — bring an existing
`docs/playbook.md` only if you want to start from your own structure.

## Keeping the pin current

`playbook.yml` pins the action by commit SHA. When a new release is cut, update the two
`uses:` lines to the new SHA and commit — the same discipline as any pinned dependency.
