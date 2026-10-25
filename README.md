<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo-light.svg" alt="A spirit level with its bubble centred" width="240">
  </picture>
</p>

<h1 align="center">standards</h1>

<p align="center">
  The rules I hold code, CI, repositories and releases to — written down precisely enough to enforce, and checked every week.
</p>

<p align="center">
  <a href="https://github.com/danfry1/standards/actions/workflows/ci.yml"><img src="https://github.com/danfry1/standards/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

One idea runs through all of it: **make the bad state impossible rather than
merely caught.** In types, the compiler proves the code correct. In tests,
every test pins real behavior and can actually fail. In the supply chain, a
compromised dependency, action or token finds nothing to grab.

Each standard is a short, self-contained document of numbered rules with
examples of what to do and what to avoid. The ones a machine can check are
checked across every repository by the [drift check](#the-drift-check).

## The standards

**Code**

| Standard | What it covers |
| --- | --- |
| [TypeScript](typescript.md) | 27 rules for config-independent type strictness: discriminated unions, branded primitives, precise generics, `unknown` at boundaries, `Result` over throwing, and no `any`, `enum` or unchecked `as`. |
| [Error handling](error-handling.md) | 14 rules so no error is ever opaque: typed errors with a literal discriminant, structured context, a preserved `cause`, narrowing instead of casting in `catch`, and one top-level handler. |
| [Testing](testing.md) | 19 rules for tests that catch regressions rather than granting false confidence: exact assertions, specific errors, determinism, isolation, and behavior over implementation. |

**Supply chain and operations**

| Standard | What it covers |
| --- | --- |
| [Supply-chain security](supply-chain-security.md) | 12 rules for the code you pull in: a 7-day cooldown at update and install time, exact pins, frozen installs, default-deny install scripts, owning your package names, an audit gate, and checking what actually runs. |
| [GitHub Actions](github-actions.md) | 15 rules for CI that can't be turned against you: verified SHA pins, read-only tokens, no persisted credentials, no script injection, no release caches, an isolated publish job, and zizmor on every workflow. |
| [Repository](repository.md) | 8 rules for how a repository is configured: tiers, security settings, rulesets on `main` and release tags, written-down exceptions, Dependabot, and a security policy a solo maintainer can keep. |
| [Releasing](releasing.md) | How releases ship on every channel — npm, crates.io, binaries, Homebrew, Scoop and GitHub Actions — keyless, traceable and approved by a human, plus how to handle a security release. |
| [Maintainer accounts](accounts.md) | 7 rules for the people behind it: passkeys, offline recovery codes, the recovery inbox as master key, no standing credentials, no personal access tokens, and a contact address on your own domain. |

Everything on one page, for reading in one go or handing to an agent:
**<https://danfry.dev/standards.md>**

## Using them

**Reading.** Start with the standard closest to what you're doing; each one
stands alone. ✅ marks the pattern to follow, ❌ the one to avoid.

**With a coding agent.** Point it at <https://danfry.dev/standards.md> (where the
markers are written as `good:` and `bad:`) and treat every rule as mandatory
for the code, configuration and workflows it writes or reviews. Some steps can
only be done by a person in a browser — registering a trusted publisher,
creating a GitHub App, approving a staged npm publish. The agent should give
exact instructions and wait, never fall back on a long-lived token.

**As a skill.** [`typescript-strict`](skills/typescript-strict/SKILL.md) packages
the TypeScript standard as an [Agent Skill](https://agentskills.io/specification)
that writes strict TypeScript and reviews a repository for type holes with a
zero-dependency scanner. For Claude Code:

```bash
ln -s "$(pwd)/skills/typescript-strict" ~/.claude/skills/typescript-strict
```

OpenCode reads `.claude/skills/`, `.opencode/skills/` and `.agents/skills/`;
other agents can load the `SKILL.md` and its `references/` directly.

## The drift check

Repository settings can't be inherited on a personal account, so they drift
quietly: a new repository never gets its security settings, an update PR sits
for months, a scheduled workflow switches itself off. The drift check catches
that.

[`baseline/drift-check.mjs`](baseline/drift-check.mjs) reads every public
repository and compares it with the rules for its tier:

- [`baseline/baseline.json`](baseline/baseline.json) — every check, the tiers it
  applies to, and the rule it enforces.
- [`baseline/repos.json`](baseline/repos.json) — every repository's tier, and
  any check it's excused from, with the reason.

It only reads, needs nothing but Node 22, and takes about half a minute:

```bash
GH_TOKEN=$(gh auth token) node baseline/drift-check.mjs                  # every repository
GH_TOKEN=$(gh auth token) node baseline/drift-check.mjs --repo bizdate --zizmor
```

Run weekly by [`drift-check.yml`](.github/workflows/drift-check.yml), it keeps
a single **Standards drift report** issue up to date, and closes it when
nothing has drifted.

## Reusable workflows

| Workflow | What it does |
| --- | --- |
| [`codeql.yml`](.github/workflows/codeql.yml) | CodeQL analysis (`languages` input, default `javascript-typescript`) |
| [`scorecard.yml`](.github/workflows/scorecard.yml) | OpenSSF Scorecard, with results sent to code scanning (`publish_results` input) |

Pin them by commit SHA, like any action:

```yaml
jobs:
  codeql:
    permissions:
      security-events: write
      contents: read
    uses: danfry1/standards/.github/workflows/codeql.yml@<sha> # vX.Y.Z
```

The `v1` tag is kept for existing callers.

## Maintaining this repository

<details>
<summary>Adding repositories, excusing checks, CI, and setting up the weekly run</summary>

**Adding a repository.** Give it a tier in `repos.json`. A public repository
missing from the file is reported.

**Excusing a check.** Add the check to the repository's `exceptions` with a
reason, optionally as `{ "reason": "...", "until": "YYYY-MM-DD" }`. An exception
without a reason, past its date, or no longer needed is reported.

**CI.** [`ci.yml`](.github/workflows/ci.yml) runs on every pull request: links
and anchors between the standards, the baseline against the drift check
([`baseline/self-check.mjs`](baseline/self-check.mjs)), and zizmor on the
workflows.

**The website.** <https://danfry.dev/standards.md> and `/standards/<topic>.md`
are generated from this repository, which stays the source of truth.

**Setting up the weekly run** (browser only, once). Until this is done, the
scheduled run is skipped. Create a GitHub App (Settings → Developer settings →
GitHub Apps → New) with webhooks off and these read-only repository
permissions:

| Permission | Used for |
| --- | --- |
| Administration | settings, rulesets, branch protection, vulnerability reporting |
| Contents | files such as `SECURITY.md`, `dependabot.yml` and workflows |
| Pull requests | the Dependabot backlog |
| Dependabot alerts | open high and critical alerts |
| Secrets, Dependabot secrets, Environments | secret *names*, never values |
| Actions | disabled workflows |
| Metadata | required by GitHub |

Install it on all repositories, then store its client ID and private key:

```bash
gh variable set DRIFT_APP_CLIENT_ID --repo danfry1/standards --body "<client-id>"
gh secret set DRIFT_APP_PRIVATE_KEY --repo danfry1/standards < drift.private-key.pem
rm drift.private-key.pem
```

Two limits worth knowing:

- A read-only token can't see rulesets' bypass actors, so the weekly run checks
  rules but not bypasses. A local run with your own token checks both.
- GitHub disables scheduled workflows after 60 days without activity, and the
  drift check can't report its own disabling. If the issue stops changing,
  check the workflow is still enabled.

</details>

## License

MIT — see [LICENSE](LICENSE).
