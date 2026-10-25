# Repository standards

A standard for how a GitHub repository is configured: who can change `main`,
which tags are permanent, how vulnerabilities reach the maintainer, and how
dependencies are kept current. These are settings, not code, so they drift
silently. Every rule here is checked by the
[drift check](https://github.com/danfry1/standards#the-baseline-and-the-drift-check),
and the machine-readable version lives in
[`baseline/baseline.json`](https://github.com/danfry1/standards/blob/main/baseline/baseline.json).

The posture: **the defaults protect the repository**, and every exception is
written down with its reason.

Legend: ✅ do · ❌ avoid.

---

## Core rules

### 1. Every repository has a tier

The tier decides which rules apply. Assign it when the repository is created
and record it in
[`baseline/repos.json`](https://github.com/danfry1/standards/blob/main/baseline/repos.json).

| Tier | What it is | Examples |
| --- | --- | --- |
| `package` | A published library or GitHub Action | npm packages, crates, JS actions |
| `tool` | A published CLI or TUI with binary releases | Homebrew/Scoop/crates.io tools |
| `distribution` | A repository bots publish into | a Homebrew tap, a Scoop bucket |
| `meta` | Shared config and standards | `standards`, `.github`, the profile repo |
| `project` | Public but not published | themes, demos, benchmarks, data |

Private repositories are out of scope unless they publish something; a private
repository that publishes is a `package` and should become public so its
releases can carry provenance.

### 2. Settings every public repository gets

| Setting | Value |
| --- | --- |
| Private vulnerability reporting | on |
| Dependabot alerts | on |
| Dependabot security updates | on |
| Secret scanning | on |
| Secret scanning push protection | on |
| Default `GITHUB_TOKEN` permission | read |
| Actions can create and approve pull requests | off |

Turning the token default to read-only is safe only after checking every
workflow either declares `permissions:` or needs nothing more than read. Check
first, then flip it.

### 3. Rulesets on `main` and on release tags

Use repository **rulesets** (not classic branch protection), with no bypass
actors.

**`main`, every tier:** block deletion and force-push.

**`main`, `package` and `tool`:** additionally require a pull request (zero
approvals - a solo maintainer cannot approve their own PR) and the CI checks
that gate a release, each pinned to the app that reports it (GitHub Actions,
`15368`, for workflow jobs).

```jsonc
// ✅ rulesets: main (package / tool)
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "do_not_enforce_on_create": false,
        "required_status_checks": [{ "context": "Quality", "integration_id": 15368 }]
      }
    }
  ]
}
```

**Release tags (`v*`), `package` and `tool`:** block deletion, update and
force-push. Creation stays allowed, so releasing works; once a version tag
exists it can never point anywhere else.

```jsonc
// ✅ rulesets: release tags
{
  "name": "release tags",
  "target": "tag",
  "enforcement": "active",
  "bypass_actors": [],
  "conditions": { "ref_name": { "include": ["refs/tags/v*"], "exclude": [] } },
  "rules": [{ "type": "deletion" }, { "type": "non_fast_forward" }, { "type": "update" }]
}
```

A GitHub Action's moving major tags (`v0`, `v1`, ...) are pointers by design
and must stay movable: exclude each one from the ruleset
(`"exclude": ["refs/tags/v0", "refs/tags/v1"]`) and move them only as part of a
release.

**Migrating from classic protection:** back up the classic configuration
first, then diff it against the ruleset. A straight migration silently drops
settings such as "require branches to be up to date", linear history and
conversation resolution.

### 4. Write every exception down

Some repositories legitimately break a rule for a while: a release that moves
its tag cannot have that tag locked until the release is reworked, and a
package that has never been published may stay off PR-only until its first
release. Each exception lives in
`baseline/repos.json` with the rule it waives and why. An exception without a
reason is a finding.

### 5. Dependabot on every ecosystem, weekly, grouped, with a cooldown

Every ecosystem the repository uses - including `github-actions` - has an
entry. Updates are weekly, wait 7 days after a release, and arrive grouped so
the weekly review is a handful of PRs.

```yaml
# ✅ .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: bun            # or npm, cargo, gomod, pip
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 10
    cooldown:
      default-days: 7
    groups:
      dev-dependencies:
        dependency-type: development
        update-types: [minor, patch]
      production-dependencies:
        dependency-type: production
        update-types: [minor, patch]

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
    open-pull-requests-limit: 5
    cooldown:
      default-days: 7
    groups:
      github-actions:
        patterns: ["*"]
```

Majors arrive as separate PRs on purpose. Every `ignore:` entry has a comment
saying why - for example, holding `@types/node` on the major that matches
`engines.node`.

### 6. A security policy that a solo maintainer can keep

Every public repository has a `SECURITY.md`, either its own or the account
default from the `.github` repository. It says:

- **How to report**: GitHub private vulnerability reporting first, with a direct
  link to `/security/advisories/new`; a security mailbox on a domain you own as
  the fallback. Never a personal or account-recovery address.
- **What to expect**: an acknowledgement within **7 days** (inside the OpenSSF
  Best Practices limit of 14), credit in the advisory if wanted, and a fix
  followed by a published advisory.
- **What is supported**: usually the latest release only.

```markdown
<!-- ✅ SECURITY.md - Reporting a Vulnerability -->
Please report security issues privately, not in a public issue, discussion or pull request:

- **Preferred:** use GitHub's private vulnerability reporting. Open this repository's
  **Security** tab and choose **Report a vulnerability**, or go to
  <https://github.com/OWNER/REPO/security/advisories/new>.
- **Alternatively:** email **security@example.dev**.

You should expect an acknowledgement within 7 days, and credit in the advisory if you
want it.
```

Promise what you can keep: a 48-hour SLA that is missed once is worse than a
7-day one that never is.

### 7. Document how the repository releases

Any repository that publishes has a `RELEASING.md` written from what its
release workflow actually does: the trigger, the human steps (approvals,
dispatches), and what to do when a step fails. Agent instructions
(`CLAUDE.md`, `AGENTS.md`) must agree with it; stale agent instructions are a
supply-chain risk, because agents act on them.

### 8. Default community files live in `.github`

`SECURITY.md` and other community health files that apply everywhere live in
the account's public `.github` repository. A repository adds its own copy only
when it says something different (supported versions, supply-chain details).

---

## Enforcement

The drift check reads `baseline/baseline.json` and `baseline/repos.json` and
reports, per repository:

| Rule | Check |
| --- | --- |
| Tier recorded | repository listed in `repos.json` |
| Settings | the table in rule 2, via the REST API |
| Rulesets | `main` and `release tags` rulesets present with the tier's rules |
| Exceptions | every waived rule has a reason |
| Dependabot | `.github/dependabot.yml` covers each ecosystem + `github-actions`, with `cooldown` |
| Security policy | own `SECURITY.md` or the `.github` default; no personal addresses |
| Release docs | `RELEASING.md` present for `package` and `tool` |
