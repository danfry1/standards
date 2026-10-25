# GitHub Actions standards

A standard for the workflows that test, build and publish code. CI is the most
privileged code in a repository: it holds tokens that can push, publish and
sign, and it runs on every pull request. The threat model is a hijacked or
moved action tag, a commit that only exists in a fork, a poisoned cache, a pull
request title that becomes a shell command, and a token that outlives the one
step that needed it.

The posture: **every workflow is least-privilege, pinned and scanned**, and the
job that can publish is the smallest, dullest job in the repository.

Legend: ✅ do · ❌ avoid.

---

## Core rules

### 1. Pin every action to a full commit SHA - and check the SHA is real

Tags and branches move. Pin every `uses:` to a 40-character commit SHA with the
version in a comment, and let Dependabot bump it.

```yaml
# ✅ immutable, and Dependabot can still read the version
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
# ❌ mutable - whoever moves the tag runs code in your CI
- uses: actions/checkout@v7
```

A pinned SHA must be reachable from the action's own repository. A commit that
exists only in a fork is still served under the parent's name (an **impostor
commit**), so verify new pins:

```bash
gh api repos/actions/checkout/commits/v7.0.1 --jq .sha   # must equal the pin
```

Pin a **tagged release**, not "latest" or a branch tip. The exception is an
action whose maintainers regenerate a branch and strand old commits
(`dtolnay/rust-toolchain`): pin a commit on its main branch and select the
toolchain with the `toolchain:` input.

Reusable workflows are actions too: `uses: owner/repo/.github/workflows/x.yml@<sha>`.

### 2. Default the token to read-only; grant per job

Set the workflow-wide default to `contents: read` (or `{}`), and grant extra
scopes only on the job that needs them.

```yaml
# ✅
permissions:
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
      id-token: write   # this job, and only this job, can mint OIDC tokens
```

```yaml
# ❌ every job, including the one running PR code, can write
permissions: write-all
# ❌ grants read on every scope, including ones no job needs
permissions: read-all
```

The repository's default `GITHUB_TOKEN` permission is also read-only
([Repository](repository.md#2-settings-every-public-repository-gets)), so a
workflow without a `permissions:` block still cannot write.

### 3. Don't persist credentials in the checkout

`actions/checkout` stores the token in `.git/config` by default, where every
later step - and any artifact that uploads the workspace - can read it.

```yaml
# ✅
- uses: actions/checkout@<sha> # vX.Y.Z
  with:
    persist-credentials: false
```

The only exception is a job that must `git push` with that token afterwards;
justify it in a comment. `gh` reads `GH_TOKEN` from the environment, so
`gh release create` and friends work without persisted credentials.

### 4. Never interpolate untrusted input into a script

`${{ }}` is expanded *before* the shell runs, so a branch name, PR title or
workflow input containing `"; curl ... | sh` becomes part of your script. Pass
values through `env:` and quote them.

```yaml
# ❌ template injection
- run: echo "Releasing ${{ github.ref_name }}"
# ✅ the shell sees a variable, not code
- env:
    TAG: ${{ github.ref_name }}
  run: echo "Releasing $TAG"
```

### 5. Keep untrusted code away from privileged triggers

`pull_request_target` and `workflow_run` run with the base repository's secrets
and a write-capable token.

- Build pull requests with plain `pull_request`.
- Never check out or run PR-authored code under `pull_request_target`.
- A `workflow_run` job that deploys must skip runs triggered by pull requests
  and must not consume artifacts produced by them.

```yaml
# ✅ a Pages deploy that only follows trusted runs
on:
  workflow_run:
    workflows: [Docs]
    types: [completed]
jobs:
  deploy:
    if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event != 'pull_request'
    runs-on: ubuntu-latest
    timeout-minutes: 10
```

### 6. No caches in release jobs

A cache written by a PR or another branch can be restored into a release build
(cache poisoning). Release and publish jobs restore nothing.

```yaml
# ✅ release jobs
- uses: actions/setup-node@<sha>
  with:
    node-version: 24
    package-manager-cache: false
- uses: actions/setup-go@<sha>
  with:
    cache: false
- uses: oven-sh/setup-bun@<sha>
  with:
    no-cache: true
```

Check a new input exists *at the pinned SHA*: an unknown input is only a
warning, so a typo leaves the cache on silently.

### 7. Split build from publish

The job that holds a publishing credential (`id-token: write`, an App token)
does as little as possible: it downloads or receives the artifact built and
tested by an earlier job, installs nothing new, runs no dependency scripts,
and publishes. Tests, builds and packing happen in jobs with read-only
permissions.

### 8. Gate releases on the tag

A release workflow triggers on a version tag and checks, before anything else:

- the tag equals the version in the manifest (`package.json`, `Cargo.toml`);
- the tagged commit is on `main`;
- the version is not already published (skip rather than fail, so a re-run is
  safe).

```yaml
# ✅
- name: Tag matches Cargo.toml
  env:
    TAG: ${{ github.ref_name }}
  run: |
    version=$(cargo metadata --no-deps --format-version 1 | jq -r '.packages[0].version')
    [ "$TAG" = "v$version" ] || { echo "tag $TAG != v$version"; exit 1; }
```

### 9. PR CI runs everything the release runs

A gate that only runs at release time fails on release day. Every check the
release performs - coverage thresholds, `publint`, `attw`, `npm pack`, the
tag-to-version check logic, packaging dry-runs - also runs on pull requests.
If the release runs `prepublishOnly`, PR CI runs the same script.

### 10. Pin the toolchain

`bun-version: latest`, `node-version: lts/*` and `go-version: stable` are
unpinned dependencies. Pin exact toolchain versions (or read them from a file
the repo controls, such as `packageManager` or `go.mod`), and let Dependabot or
a deliberate PR move them.

### 11. Scan every workflow with zizmor

Run [zizmor](https://docs.zizmor.sh) at a pinned version against every
workflow, fix what it finds, and justify what you keep inline so the next scan
is quiet. The ignore needs its own `#` after the version comment; zizmor does
not see `# vX.Y.Z zizmor: ignore[...]`.

```bash
uvx --from 'zizmor==1.31.1' zizmor .github/workflows
```

Use a current release: before 1.31, zizmor's default policy accepted tag pins
for `actions/*`, so `actions/checkout@v7` passed. Dependabot cannot bump a
version written inside a script, so move the pin deliberately.

```yaml
# ✅ a justified exception, on the flagged line, visible in review
# This job pushes the bump branch with the App token, so it keeps credentials.
- uses: actions/checkout@<sha> # vX.Y.Z # zizmor: ignore[artipacked]
  with:
    repository: owner/homebrew-tap
    token: ${{ steps.app-token.outputs.token }}
```

### 12. Cross-repo writes use a GitHub App token, never a PAT

`GITHUB_TOKEN` covers the repository the workflow runs in. For anything else -
pushing a formula to a tap, a manifest to a bucket - mint a short-lived token
from a GitHub App scoped to exactly the target repositories.

```yaml
# ✅ expires in an hour, scoped to one repository and the permissions it needs
- id: app-token
  uses: actions/create-github-app-token@<sha> # vX.Y.Z
  with:
    client-id: ${{ vars.TAP_BUMP_APP_CLIENT_ID }}
    private-key: ${{ secrets.TAP_BUMP_APP_PRIVATE_KEY }}
    repositories: homebrew-tap
    permission-contents: write
    permission-pull-requests: write
```

A personal access token is long-lived, tied to a person and usually
over-scoped. See [Maintainer accounts](accounts.md#5-no-personal-access-tokens-one-key-per-github-app).

### 13. Bound every job

Give every job a `timeout-minutes`. A hung step otherwise holds a runner, and
its token, for six hours.

### 14. Keep scheduled workflows alive

GitHub disables scheduled workflows after 60 days without repository activity,
silently. A weekly canary that stopped running looks exactly like one that
keeps passing. Check for disabled workflows:

```bash
gh api repos/OWNER/REPO/actions/workflows \
  --jq '.workflows[] | select(.state != "active") | "\(.name): \(.state)"'
```

### 15. Required checks are pinned to the app that reports them

A ruleset's required check names a job *and* the app that must report it
(`integration_id: 15368` for GitHub Actions; code scanning reports `CodeQL`
from its own app), so another app cannot satisfy it with a same-named check.
Rename a job only together with the ruleset, and don't require matrix jobs
whose names change with every dependency bump.

---

## Enforcement

| Control | Check | Automated |
| --- | --- | --- |
| SHA pins, impostor commits | zizmor `unpinned-uses`, `impostor-commit` | yes (`--zizmor`) |
| Token scope | zizmor `excessive-permissions`; repository default token read-only | yes |
| Persisted credentials | zizmor `artipacked` | yes (`--zizmor`) |
| Template injection | zizmor `template-injection` | yes (`--zizmor`) |
| Dangerous triggers | zizmor `dangerous-triggers` | yes (`--zizmor`) |
| Release caches | zizmor `cache-poisoning` | yes (`--zizmor`) |
| Disabled workflows | workflow state via the API | yes |
| Required checks | every required check has an `integration_id` | yes |
| Isolated publish, tag gate, toolchain pins, timeouts | review of the release workflow | by hand |
