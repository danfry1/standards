# Supply-chain hardening

Defense-in-depth against dependency- and CI-based supply-chain attacks for a TypeScript library. Each control is independent; adopt them together for layered protection. The threat model is mostly: a dependency (or a transitive one, or a GitHub Action) ships a malicious version and you pull it in automatically.

| # | Control | Defends against |
|---|---|---|
| 1 | Release-age gate (`minimumReleaseAge`) | Installing a just-published malicious version before it's caught |
| 2 | Dependency update cooldown (Dependabot) | Auto-merging a malicious version via an update PR |
| 3 | Exact pinning of dev deps (syncpack) | Silent drift into an unreviewed version |
| 4 | Committed lockfile | Non-reproducible installs; resolution-time substitution |
| 5 | SHA-pinned GitHub Actions | A moved/compromised action tag injecting code into CI |
| 6 | Least-privilege workflow permissions | A compromised step exfiltrating secrets or pushing code |
| 7 | Automated scanning (CodeQL, Scorecard) | Latent vulns; posture regressions |
| 8 | Publish provenance | Consumers can't verify what built the artifact |

---

## 1. Release-age gate

Refuse npm versions published more recently than a threshold. A freshly-published malicious version is most dangerous in its first hours/days; waiting a week means most get reported and yanked first. This is install-time defense — it applies even to manual `bun add`.

`bunfig.toml`:

```toml
[install]
# Refuse versions published more recently than this many seconds. 604800 = 7 days.
minimumReleaseAge = 604800
# Temporary, surgical exceptions when you must adopt something fresh:
# minimumReleaseAgeExcludes = ["some-pkg"]
```

> Requires Bun ≥ 1.2.x. The equivalent for pnpm is `minimumReleaseAge` in `.npmrc`/`pnpm-workspace.yaml`; for npm there's no native equivalent, so lean on the Dependabot cooldown (#2).

## 2. Dependency update cooldown

The primary one-week gate. Dependabot holds update PRs until a version has been public for N days, mirroring #1 but at the PR level (so even auto-merge can't pull a same-day release).

`.github/dependabot.yml` — see [snippets/dependabot.yml](./snippets/dependabot.yml). Key parts:

```yaml
version: 2
updates:
  - package-ecosystem: bun        # or npm / pnpm
    directory: /
    schedule: { interval: weekly, day: monday }
    cooldown:
      default-days: 7
      semver-major-days: 7
      semver-minor-days: 7
      semver-patch-days: 7
    groups:
      dev-dependencies: { dependency-type: development, update-types: [minor, patch] }
      production-dependencies: { dependency-type: production, update-types: [minor, patch] }
  - package-ecosystem: github-actions   # keep your pinned action SHAs fresh
    directory: /
    schedule: { interval: weekly, day: monday }
    cooldown: { default-days: 7 }
```

The `github-actions` ecosystem is what keeps SHA-pinned actions (#5) up to date — Dependabot bumps the SHA and updates the `# vX` comment for you.

## 3. Exact pinning of dev dependencies

Pin every `devDependency` to an exact version (no `^`/`~`) so a `bun install` can never silently pick up an unreviewed version; updates only arrive through a reviewed Dependabot PR. Runtime (`dependencies`) and `peerDependencies` keep ranges so consumers can dedupe.

Enforce with [syncpack](https://github.com/JamieMason/syncpack). `.syncpackrc.json` — see [snippets/.syncpackrc.json](./snippets/.syncpackrc.json):

```json
{
  "semverGroups": [
    { "label": "devDependencies pinned to exact (supply-chain)", "dependencyTypes": ["dev"], "range": "" },
    { "label": "runtime + peer keep ranges so consumers can dedupe", "dependencyTypes": ["prod", "peer"], "isIgnored": true }
  ]
}
```

Scripts + CI gate:

```jsonc
// package.json
"scripts": {
  "lint:deps": "syncpack lint",   // run this in CI — fails if anything isn't pinned
  "fix:deps": "syncpack fix"
}
```

**Gotcha — pin to what you run, not the range floor.** `syncpack fix` rewrites `^0.9.0` → `0.9.0` (it strips the operator from the *declared* version). If your lockfile was actually resolving `0.9.9`, you've just downgraded. After `fix:deps`, run your full build/test, and bump any pin to the version the lockfile used. (Confirm with `bun pm ls <pkg>` or the lockfile.)

**Gotcha — entangled peer/dev deps.** A package that appears as both a wide `peerDependency` (`>=8`) and a pinned `devDependency` will trip syncpack's version-unification check. Ignore those specific deps with a `versionGroup`:

```json
{ "versionGroups": [{ "dependencies": ["eslint", "typescript"], "isIgnored": true }] }
```

The lockfile still pins their resolved versions, so reproducibility holds.

## 4. Committed lockfile

Commit `bun.lock` (don't `.gitignore` it). It pins the entire transitive tree to exact resolved versions + integrity hashes. CI must install with `--frozen-lockfile` so a drifted lockfile fails the build instead of silently re-resolving:

```yaml
- run: bun install --frozen-lockfile
```

> If you use `--frozen-lockfile` in CI, the lockfile **must** be committed, or CI has nothing to freeze against.

## 5. SHA-pin GitHub Actions

A tag like `@v4` is mutable — whoever controls the action can move it (or an attacker who compromises the repo can). Pin to a full commit SHA, with the version as a comment so Dependabot (#2) can bump it:

```yaml
- uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10 # v6
```

Current pinned SHAs (Dependabot keeps these fresh):

| Action | SHA | Tag |
|---|---|---|
| `actions/checkout` | `df4cb1c069e1874edd31b4311f1884172cec0e10` | v6 |
| `actions/setup-node` | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` | v6.4.0 |
| `oven-sh/setup-bun` | `0c5077e51419868618aeaa5fe8019c62421857d6` | v2 |
| `github/codeql-action/*` | `87557b9c84dde89fdd9b10e88954ac2f4248e463` | v4 |
| `ossf/scorecard-action` | `4eaacf0543bb3f2c246792bd56e8cdeffafb205a` | v2.4.3 |
| `actions/configure-pages` | `45bfe0192ca1faeb007ade9deae92b16b8254a0d` | v6.0.0 |
| `actions/upload-pages-artifact` | `fc324d3547104276b827a68afc52ff2a11cc49c9` | v5.0.0 |
| `actions/deploy-pages` | `cd2ce8fcbc39b97be8ca5fce6e763baed58fa128` | v5.0.0 |
| `changesets/action` | `a45c4d594aa4e2c509dc14a9f2b3b67ba3780d0d` | v1 |

> Resolve a tag to its SHA with: `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`.
>
> **Exception:** your *own* reusable workflows (this repo) are referenced by tag (`@v1`), not SHA — you control the repo, and tag-by-SHA there would defeat central updates.

## 6. Least-privilege workflow permissions

The default `GITHUB_TOKEN` is powerful. Set the floor to read-only at the workflow level and grant write scopes only to the jobs that need them:

```yaml
permissions: read-all   # workflow-level floor

jobs:
  analyze:
    permissions:
      security-events: write   # only this job, only this scope
```

Also: never interpolate untrusted `github.event.*` (issue/PR titles, commit messages, branch names) directly into `run:` — pass via `env:` and quote, to avoid script injection.

## 7. Automated scanning

**CodeQL** (static analysis) and **OpenSSF Scorecard** (supply-chain posture score) on every push and weekly. These are uniform across repos, so this `standards` repo ships them as **reusable** workflows — call them:

```yaml
# .github/workflows/codeql.yml in your repo
name: CodeQL
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
  schedule: [{ cron: '0 6 * * 1' }]
permissions: read-all
jobs:
  codeql:
    permissions: { security-events: write, contents: read }
    uses: danfry1/standards/.github/workflows/codeql.yml@v1
```

```yaml
# .github/workflows/scorecard.yml in your repo
name: OpenSSF Scorecard
on:
  push: { branches: [main] }
  schedule: [{ cron: '0 6 * * 1' }]
  workflow_dispatch:
permissions: read-all
jobs:
  scorecard:
    permissions: { security-events: write, id-token: write }
    uses: danfry1/standards/.github/workflows/scorecard.yml@v1
```

## 8. Publish provenance

Publish with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) so the registry records a signed, verifiable link from the artifact to the building workflow and commit:

```yaml
permissions:
  id-token: write        # required for provenance
# ...
env:
  NPM_CONFIG_PROVENANCE: 'true'
# or: npm publish --provenance --access public
```

Requires the publish to run from a public CI workflow with an OIDC token.

---

## Adoption checklist

- [ ] `bunfig.toml` has `minimumReleaseAge = 604800`
- [ ] `.github/dependabot.yml` with 7-day cooldown for both `bun` and `github-actions`
- [ ] `.syncpackrc.json` + `lint:deps` script, **run in CI**
- [ ] `bun.lock` committed; CI uses `--frozen-lockfile`
- [ ] All actions SHA-pinned with `# vX` comments
- [ ] Workflows default to `permissions: read-all`
- [ ] CodeQL + Scorecard wired to the reusable workflows
- [ ] Publish uses provenance (`id-token: write` + `NPM_CONFIG_PROVENANCE`)
- [ ] `SECURITY.md` links here
