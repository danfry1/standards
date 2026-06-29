# Supply-chain security standards (JS/TS — npm/pnpm)

A standard for defending the software supply chain: the dependencies pulled in,
the CI that builds the code, and the packages published out. The threat model is
concrete — a compromised transitive dependency, a malicious version pushed to a
package you already trust, a hijacked GitHub Action, or a poisoned pull request
reaching your secrets.

The posture mirrors the rest of these standards: make the attack **impossible by
construction**, not merely monitored. Default-deny, pin everything, grant least
privilege, and put *time and verification* between an upstream compromise and
your build. Most malicious package versions are caught and unpublished within
hours to days — so a cooldown alone defeats a large class of attacks.

Legend: ✅ do · ❌ avoid.

---

## Core rules

### 1. Minimize the dependency surface

Every dependency — and every one of *its* dependencies — is code you ship and
trust. Prefer the platform/stdlib, prefer a few well-audited libraries over many
micro-packages, and delete unused deps. The cheapest supply-chain attack to
survive is the one you never installed.

### 2. Enforce a minimum release age (cooldown)

Never install a version the moment it publishes. Require it to have been public
for a cooldown window (7–14 days) so malicious or broken releases are caught and
unpublished before they reach your tree.

```yaml
# .npmrc (pnpm ≥ 10.16) — refuse versions younger than the window
minimumReleaseAge=10080            # minutes = 7 days
```

Apply the same gate to automated updates — Renovate's `minimumReleaseAge` (and a
matching `internalChecksFilter`) holds a PR open until the version has aged.
Cooldown is the single highest-leverage control here.

### 3. Vet a dependency before it enters the tree

Adding a package is a security decision, not a convenience. Before it lands:
check maintenance and provenance (repo, release history, maintainer count),
whether it runs install scripts, its transitive footprint, and known advisories.
Tools like Socket or `osv-scanner` automate the first pass — a human still
approves the add.

### 4. Pin exact versions — enforce with syncpack

Ranges (`^`, `~`) let an attacker's freshly-published patch in without a code
change. Pin exact versions everywhere and let the lockfile and `package.json`
agree. In a monorepo, `syncpack` enforces both pinning and cross-workspace
consistency in CI.

```jsonc
// .syncpackrc — pin everything; fail CI on a range or a mismatch
{
  "dependencyTypes": ["prod", "dev", "peer"],
  "versionGroups": [{ "packages": ["**"], "preferVersion": "pin" }],
  "semverGroups": [{ "packages": ["**"], "range": "" }]
}
```

```
syncpack lint        # CI: nonzero exit on any range or version mismatch
```

### 5. Commit the lockfile; install frozen

The lockfile is the integrity boundary — it pins resolved versions *and* their
SRI hashes. Commit it, review changes to it like code, and in CI install with the
lockfile frozen so a drifted or tampered tree fails the build instead of silently
resolving something new.

```
pnpm install --frozen-lockfile        # npm: `npm ci`
```

Never let CI write the lockfile. A diff to integrity hashes with no dependency
change is a red flag, not a rebase artifact.

### 6. Default-deny lifecycle scripts; allowlist the few that need them

`postinstall`/`preinstall` scripts run arbitrary code on every machine that
installs — a top malware delivery vector. Block them by default and allowlist
only the packages that genuinely need a native build.

```yaml
# .npmrc — npm: block all install scripts
ignore-scripts=true
```

pnpm 10 already default-denies build scripts; grant them explicitly:

```yaml
# pnpm-workspace.yaml / package.json
onlyBuiltDependencies:
  - esbuild
  - "@swc/core"
```

Run CI installs with `--ignore-scripts` even so.

### 7. Scope internal packages — kill dependency confusion

An unscoped internal name (`utils`, `config`) can be hijacked by an attacker
publishing the same name publicly at a higher version. Scope every internal
package (`@org/…`), and pin that scope to the private registry so it can never
resolve from the public one.

```yaml
# .npmrc
@org:registry=https://registry.internal.example/
//registry.internal.example/:_authToken=${NPM_TOKEN}
```

Reserve your scope on the public registry too, so the name simply can't be taken.

### 8. Pin GitHub Actions to a full commit SHA, not a tag

Tags are mutable: an attacker who moves `v4` (or compromises a popular action)
gets code execution inside your CI with your secrets. Pin every `uses:` to a
full 40-char commit SHA and let a bot bump it deliberately.

```yaml
# ✅ immutable
- uses: actions/checkout@b4ffde65f46336ab88eb53be808477a3936bae11 # v4.1.1
# ❌ mutable — a moved tag is silent RCE (cf. the tj-actions/changed-files incident)
- uses: actions/checkout@v4
```

### 9. Least-privilege `GITHUB_TOKEN`

Default the token to read-only and grant the minimum each job needs, at the job
level. A token that can't write can't be turned against the repo.

```yaml
permissions:
  contents: read            # top-level default for the whole workflow
# grant more only on the specific job that needs it, e.g. id-token: write to publish
```

### 10. Never run untrusted PR code with access to secrets

`pull_request_target` runs in the *base* repo's context — with secrets and a
write token — while the PR's code is untrusted. Checking out and building the PR
head under that trigger hands a fork author your secrets. Don't.

```yaml
# ❌ the classic exfiltration footgun
on: pull_request_target
jobs:
  build:
    steps:
      - uses: actions/checkout@<sha>
        with: { ref: ${{ github.event.pull_request.head.sha }} }   # untrusted
      - run: npm install && npm run build                          # with secrets in scope
```

Build untrusted PRs with the plain `pull_request` trigger (no secrets, read-only
token). If a privileged step must follow, split it into a separate `workflow_run`
job that never executes PR-authored code. Gate any deploy/publish behind a
GitHub Environment with required reviewers.

### 11. Harden the CI runner

Treat the runner as hostile-adjacent: pin tool versions, set `persist-credentials:
false` on checkout when the token isn't needed afterward, and add egress
control (e.g. StepSecurity `harden-runner` in audit-then-block mode) so a
compromised step can't quietly phone home or exfiltrate to an unknown host.

### 12. Publish with provenance via OIDC — not a long-lived token

Publish from CI using npm **trusted publishing** (OIDC), which mints a
short-lived credential and attaches a Sigstore **provenance** attestation tying
the artifact to the exact commit and workflow that built it. No `NPM_TOKEN`
secret to steal, and consumers can verify where the package came from.

```yaml
permissions:
  id-token: write           # required for OIDC + provenance
# - run: npm publish --provenance --access public
```

If a token is unavoidable, use a granular, least-privilege automation token
scoped to the one package, store it only as a CI secret, and rotate it.

### 13. Stage every publish — soak on a dist-tag before `latest`

Publishing straight to `latest` makes every consumer an instant blast radius.
Publish to a pre-release tag first, let it bake (and run smoke tests / canary
installs), then promote the *same* immutable version to `latest`.

```
npm publish --tag next                       # nobody on `latest` is affected yet
# …soak, verify provenance, smoke-test…
npm dist-tag add @org/pkg@1.4.0 latest       # promote, no rebuild
```

### 14. Require 2FA and protect the human side

Enforce 2FA for every maintainer and for publish on the registry. Keep the
maintainer list small and reviewed, and remove access promptly when it's no
longer needed. The strongest pipeline still falls to a phished maintainer
account.

### 15. Scan continuously and keep an SBOM

Run advisory scanning in CI (`osv-scanner`, `npm audit`, Socket, Dependabot
alerts) and generate an SBOM (CycloneDX or SPDX) on every release so you can
answer "are we affected?" in minutes when the next advisory drops. Scanning is
detection, not prevention — it backs the rules above; it does not replace them.

### 16. Verify integrity and attestations on install

Beyond the lockfile's SRI hashes, verify signatures/attestations where the
registry supports them (`npm audit signatures` checks registry signatures and
provenance for the installed tree). A failed verification fails the build.
