# standards

My engineering standards - the patterns I hold code, repositories and releases
to, written down precisely enough to be enforceable. The throughline is the same
everywhere: **make the bad state impossible rather than merely caught**. In
types, that means the compiler proves correctness; in tests, every test pins
real behavior and can actually fail; in the supply chain, a compromised
dependency, action or token has nothing to grab.

Every standard is a self-contained, example-driven document. The ones that can
be checked by a machine are, every week, across every repository (see
[the baseline and the drift check](#the-baseline-and-the-drift-check)).

## Standards

**Code**

| Standard | What it covers |
| --- | --- |
| [**TypeScript**](typescript.md) | 27 rules for maximum, config-independent type strictness - discriminated unions, branded primitives, precise generics, `unknown` boundaries, `Result` over throwing; no `any`/`enum`/unchecked `as`. Each rule maps to the `tsconfig`/lint flag that locks it in. |
| [**Error handling**](error-handling.md) | 14 rules so no error is ever opaque - typed custom errors with a literal discriminant, structured context, preserved `cause`, narrow-don't-cast in `catch`, and one exhaustive top-level handler. |
| [**Testing**](testing.md) | 19 rules for tests that catch regressions instead of granting *fake safety* - exact assertions over truthiness, specific errors, determinism, isolation, behavior over implementation. For Vitest & Jest. |

**Supply chain and operations**

| Standard | What it covers |
| --- | --- |
| [**Supply-chain security**](supply-chain-security.md) | 12 rules for the code you pull in - zero runtime dependencies, a 7-day cooldown at update *and* install time, exact pins, frozen installs, default-deny install scripts, owning your names, an audit gate, and checking what actually runs. |
| [**GitHub Actions**](github-actions.md) | 15 rules for CI that can't be turned against you - SHA pins verified against the action's repo, read-only tokens, no persisted credentials, no template injection, no release caches, an isolated publish job, and zizmor on every workflow. |
| [**Repository**](repository.md) | 8 rules for how a repository is configured - tiers, security settings, rulesets on `main` and release tags, documented exceptions, Dependabot with a cooldown, and a security policy a solo maintainer can keep. |
| [**Releasing**](releasing.md) | Principles and per-channel rules for npm (staged, OIDC, 2FA-approved), crates.io (trusted-only), binaries (checksums + attestations), Homebrew (source formulae + bottles behind a manual gate), Scoop, GitHub Actions, and security releases. |
| [**Maintainer accounts**](accounts.md) | 7 rules for the humans behind it - passkeys, offline recovery codes, the recovery inbox as master key, no standing credentials, no PATs, and a contact address on a domain you own. |

All of it, in one page for coding agents: **<https://danfry.dev/standards.md>**.

## For coding agents

Treat every rule as mandatory for the code, configuration and workflows you
write or review, wherever the rule's language or tooling applies. Examples mark
the required pattern with ✅ (`good:` on the website) and the anti-pattern with
❌ (`bad:`).

Some steps cannot be done from a terminal - registering a trusted publisher,
creating a GitHub App, approving a staged npm publish. Give the human exact
instructions and wait; never substitute a long-lived token to get around them.

## The baseline and the drift check

Settings drift silently, so the rules that can be checked by a machine are:

- [`baseline/baseline.json`](baseline/baseline.json) - every check, which
  repository tiers it applies to, and the rule it enforces.
- [`baseline/repos.json`](baseline/repos.json) - every public repository, its
  tier, and any check it is excused from, with the reason.
- [`baseline/drift-check.mjs`](baseline/drift-check.mjs) - checks every public
  repository against both and prints a report. Zero dependencies; Node 22+.

Run it locally (read-only):

```bash
GH_TOKEN=$(gh auth token) node baseline/drift-check.mjs            # every repository
GH_TOKEN=$(gh auth token) node baseline/drift-check.mjs --repo bizdate --zizmor
```

[`drift-check.yml`](.github/workflows/drift-check.yml) runs it every Monday and
keeps one issue, **Standards drift report**, current; the issue closes itself
when nothing has drifted.

**Adding a repository:** give it a tier in `repos.json`. A public repository
missing from the file is itself reported.

**Excusing a check:** add it to the repository's `exceptions` with the reason.
An exception without a reason is reported as a failure.

**One-time setup for the scheduled run** (browser only). Create a GitHub App
(Settings -> Developer settings -> GitHub Apps -> New), with webhooks off and
these **read-only** repository permissions:

| Permission | Why |
| --- | --- |
| Administration | settings, rulesets, branch protection, vulnerability reporting |
| Contents | files such as `SECURITY.md`, `dependabot.yml`, workflows |
| Pull requests | the Dependabot backlog |
| Dependabot alerts | open high/critical alerts |
| Secrets | repository secret *names* (never values) |
| Dependabot secrets | Dependabot secret names |
| Environments | environment secret names |
| Actions | disabled workflows |
| Metadata | required by GitHub |

Install it on all repositories, then store its client ID and key here:

```bash
gh variable set DRIFT_APP_CLIENT_ID --repo danfry1/standards --body "<client-id>"
gh secret set DRIFT_APP_PRIVATE_KEY --repo danfry1/standards < drift.private-key.pem
rm drift.private-key.pem
```

A read-only token cannot see rulesets' bypass actors (GitHub shows them only
to tokens with write access), so the scheduled run checks rules but not
bypasses; a local run with your own token checks both.

GitHub disables scheduled workflows after 60 days without repository
activity, and the drift check cannot report its own disabling. If the issue
stops changing, check the workflow is still enabled.

## Reusable workflows

| Workflow | What it does |
| --- | --- |
| [`codeql.yml`](.github/workflows/codeql.yml) | CodeQL analysis (`languages` input, default `javascript-typescript`) |
| [`scorecard.yml`](.github/workflows/scorecard.yml) | OpenSSF Scorecard, results to code scanning (`publish_results` input) |

Call them pinned by commit SHA, like any action. Releases of this repository
are tagged (`v2` onwards) so Dependabot can keep callers' pins current:

```yaml
jobs:
  codeql:
    permissions:
      security-events: write
      contents: read
    uses: danfry1/standards/.github/workflows/codeql.yml@<sha> # vX.Y.Z
```

The `v1` tag stays where it is for existing callers.

## Skills

| Skill | What it does |
| --- | --- |
| [`typescript-strict`](skills/typescript-strict/SKILL.md) | The TypeScript standard as a working [Agent Skill](https://agentskills.io/specification). **Authors** robust, config-independent TS and **reviews** any repo for type holes and strictness gaps via a zero-dep scanner, calibrated to the repo's config. Strict `tsconfig` and lint configs ship as **optional** enforcement. |

**Claude Code** - symlink (or copy) a skill into a project's or your user skills
directory:

```bash
ln -s "$(pwd)/skills/typescript-strict" ~/.claude/skills/typescript-strict
```

**OpenCode** reads `.claude/skills/`, `.opencode/skills/` and `.agents/skills/`;
**Codex and other agents** can reference the `SKILL.md` and its `references/`
from wherever they load instructions.

## Layout

```
standards/
├── typescript.md              # code
├── error-handling.md
├── testing.md
├── supply-chain-security.md   # supply chain and operations
├── github-actions.md
├── repository.md
├── releasing.md
├── accounts.md
├── baseline/
│   ├── baseline.json          # the machine-checkable rules
│   ├── repos.json             # every repository's tier and exceptions
│   └── drift-check.mjs        # the checker
├── skills/
│   └── typescript-strict/
└── .github/workflows/
    ├── codeql.yml             # reusable
    ├── scorecard.yml          # reusable
    └── drift-check.yml        # weekly drift report
```

The website copy (<https://danfry.dev/standards.md> and
`/standards/<topic>.md`) is generated from this repository; this repository is
the source of truth.

## License

MIT - see [LICENSE](LICENSE).
