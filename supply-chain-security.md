# Supply-chain security standards (dependencies - JS/TS, Rust, Go)

A standard for the code you pull in: every direct and transitive dependency, the
toolchain that installs it, and the bots that update it. The threat model is
concrete - a malicious version pushed to a package you already trust, a
typosquat or a name someone registered before you, a compromised maintainer, or
an advisory that sits unpatched in your lockfile for months.

The posture mirrors the rest of these standards: make the attack **impossible by
construction**, not merely monitored. Pin everything, refuse anything too new,
install exactly what was reviewed, and fail the build the moment a known
advisory appears. Most malicious releases are found and pulled within days, so
putting *time* between a publish and your install defeats a large class of
attacks on its own.

The rest of the supply chain has its own standard:

- [GitHub Actions](github-actions.md) - the CI that builds and publishes.
- [Releasing](releasing.md) - how artifacts leave the repo, with provenance.
- [Repository](repository.md) - settings, rulesets, Dependabot, security policy.
- [Maintainer accounts](accounts.md) - the humans and tokens behind it all.

Legend: ✅ do · ❌ avoid.

---

## Core rules

### 1. Minimize the dependency surface

Every dependency - and every one of *its* dependencies - is code you ship and
trust. Prefer the platform and standard library, prefer one well-maintained
library over several micro-packages, and delete what you no longer use. A
library should aim for **zero runtime dependencies**; what it needs at build or
test time stays in `devDependencies`.

When a feature needs a heavy package only some users want (a CLI that needs
`typescript`, say), make it an **optional peer dependency** loaded lazily by
that feature, so the core stays dependency-free.

```jsonc
// ✅ package.json - the CLI loads typescript on demand; the library never does
{
  "peerDependencies": { "typescript": ">=5" },
  "peerDependenciesMeta": { "typescript": { "optional": true } }
}
```

### 2. Put a cooldown between a publish and your install

Never take a version the moment it is published. Require it to have been public
for **7 days**, in two layers:

1. **Update bots** wait: Dependabot's `cooldown` holds the PR until the version
   has aged (see [Repository](repository.md#5-dependabot-on-every-ecosystem-weekly-grouped-with-a-cooldown)).
2. **The package manager** refuses young versions at install time, so a version
   added or bumped by hand gets the same gate.

```toml
# ✅ bunfig.toml (Bun >= 1.3) - seconds; 604800 = 7 days
[install]
minimumReleaseAge = 604800
```

```yaml
# ✅ pnpm-workspace.yaml (pnpm >= 10.16) - minutes; 10080 = 7 days
minimumReleaseAge: 10080
```

Installs from a committed lockfile are unaffected; the gate applies when a
version is resolved. Floating tags (`@latest`, `@next`) silently resolve to the
newest version old enough, rather than failing.

**Security fixes younger than the window.** When an advisory's fix is newer than
7 days, exclude that one package temporarily and remove the exclusion once the
fix has aged. Never lower the window for everything.

```toml
[install]
minimumReleaseAge = 604800
minimumReleaseAgeExcludes = ["undici"]   # ✅ temporary: GHSA-xxxx, fix published 2 days ago
```

### 3. Vet a dependency before it enters the tree

Adding a package is a security decision. Before it lands, check:

- **Who publishes it**: the registry's publisher field and provenance
  (`npm view <pkg>@<version> _npmUser dist.attestations`). A release published
  by CI with provenance is a stronger signal than a hand publish.
- **How old it is**, how often it releases, and how many maintainers it has.
- **Whether it runs install scripts**, and how many transitive packages it adds.
- **Known advisories** (`bun audit`, `cargo audit`, `govulncheck`) before and
  after adding it.

### 4. Pin exact versions

Ranges (`^`, `~`) let a freshly published patch in without a code change. Pin
exact versions of everything you install for yourself - `devDependencies`, and
every dependency of an application - and enforce it, so a stray `^` fails CI
rather than quietly widening the tree.

A **library's** `dependencies` and `peerDependencies` are the exception: they
describe what *consumers* may use, and ranges let consumers deduplicate. Your
own lockfile still pins exactly what your CI tests.

```toml
# ✅ bunfig.toml - `bun add` writes exact versions
[install]
exact = true
```

```jsonc
// ✅ .syncpackrc.json - devDependencies exact; a library's runtime and peer ranges left alone
{
  "semverGroups": [
    { "label": "Dev tooling is pinned exactly", "dependencyTypes": ["dev"], "range": "" },
    { "label": "Runtime and peer ranges are for consumers", "dependencyTypes": ["prod", "peer"], "isIgnored": true }
  ]
}
```

An application (or a library with no runtime dependencies) can pin
everything: drop the second group and add `"prod"` to the first. Run
`syncpack lint` in CI. Rust and Go get the same guarantee from their lockfiles
(`Cargo.lock`, `go.sum`) plus a locked build (rule 5).

### 5. Commit the lockfile; install frozen everywhere

The lockfile pins resolved versions *and* their integrity hashes. Commit it,
review changes to it like code, and make every CI and release install refuse to
change it.

```bash
# ✅ one per toolchain
bun install --frozen-lockfile
npm ci
pnpm install --frozen-lockfile
cargo build --locked              # and cargo package/publish --locked
go build -mod=readonly ./...
```

A lockfile diff that changes integrity hashes without changing versions is a
red flag, not a rebase artifact.

### 6. Default-deny install scripts

`preinstall`/`postinstall` scripts run arbitrary code on every machine that
installs - a top malware delivery vector.

- **Bun** runs install scripts for a built-in allow-list of popular packages
  unless `package.json` says otherwise. A *missing* `trustedDependencies` field
  means that list applies; set it explicitly, empty or with a justified list.
  `ignoreScripts = true` under `[install]` in `bunfig.toml` turns off every
  script instead.
- **npm**: `ignore-scripts=true` in `.npmrc`.
- **pnpm** default-denies; allow only what needs a native build, with
  `onlyBuiltDependencies` (pnpm 10) or `allowBuilds` (pnpm 11).

```jsonc
// ✅ package.json (Bun) - no dependency runs an install script
{ "trustedDependencies": [] }
```

```ini
# ✅ .npmrc
ignore-scripts=true
```

Any job that holds a publishing credential installs with scripts disabled, or
installs nothing at all (see [GitHub Actions](github-actions.md#7-split-build-from-publish)).

### 7. Own your names - kill dependency confusion and squatting

An internal or announced-but-unpublished name can be taken by someone else.

- **Scope** internal packages (`@org/...`) and pin the scope to its registry.
- **Register a name before you announce it** - including the name your README
  tells people to install. A `<project>-cli` package mentioned in docs but never
  published is an open invitation.
- Prefer shipping a CLI as a `bin` inside the main package (`npx <project>`) over a
  second package name you then have to defend.

### 8. Audit in CI, as its own job

Fail the build on known advisories of **high or critical** severity, on every
pull request and on `main`. Run the audit in its **own job** with no `needs:`,
so a new advisory (or a registry outage) is reported on its own instead of
skipping every other check.

```yaml
# ✅ an independent job
audit:
  name: Audit dependencies
  runs-on: ubuntu-latest
  timeout-minutes: 10
  steps:
    - uses: actions/checkout@<sha> # vX.Y.Z
      with:
        persist-credentials: false
    - uses: oven-sh/setup-bun@<sha> # vX.Y.Z
      with:
        bun-version: 1.3.14
    - run: bun install --frozen-lockfile
    - run: bun audit --audit-level=high
```

Rust: `rustsec/audit-check` (or `cargo audit`/`cargo deny check advisories`).
Go: `govulncheck ./...`. An ignored advisory names its ID, the reason, and the
date the ignore should be revisited.

### 9. Fix advisories in the smallest correct way

In order of preference:

1. **Lockfile-only, within range.** If the parent's declared range already
   accepts the fixed version, update just that lock entry (with the registry's
   integrity hash), prove it with a frozen install, and run the full quality job.
   Every install is frozen, so the lockfile *is* what CI and releases use.
2. **Bump the parent** when its range excludes the fix.
3. **Override** (`overrides`/`resolutions`) only when no parent release accepts
   the fix yet; comment it with the advisory ID and remove it when the parent
   catches up.

```bash
# ❌ adds the transitive package to `dependencies` - wrong for a zero-dep library
bun update undici
```

Majors that must move together move in **one** change. A coverage plugin that
peers on an exact test-runner version breaks if either lands alone.

### 10. Check what actually runs, not what the lockfile says

Some packages ship their dependencies inside their own tarball, ignoring your
lockfile entirely:

- **npm** bundles its dependencies. Its lock entries can look patched while the
  installed npm still runs the old code; only upgrading npm itself fixes them.
  Check `node_modules/npm/node_modules/<dep>/package.json`.
- **A JavaScript GitHub Action** bundles its runtime into `dist/`. An advisory in
  a runtime dependency ships to every workflow that uses the action until
  `dist/` is rebuilt and released.

When an audit says "fixed", confirm the version in the installed tree or the
built artifact.

### 11. Keep the update backlog empty

Advisories accumulate in unmerged update PRs. Merge or close Dependabot's PRs
every week; a backlog older than a month is a finding in its own right.
Grouped minor/patch updates should be routine; majors get read (changelog, peer
ranges, engine requirements) and merged on their own.

### 12. Verify signatures and provenance on install

Beyond the lockfile's hashes, verify registry signatures and provenance for the
installed tree where the registry supports it.

```bash
npm audit signatures   # ✅ registry signatures + provenance attestations
```

A failed verification fails the build.

---

## Enforcement

| Control | Check | Automated |
| --- | --- | --- |
| Cooldown (bot) | `cooldown.default-days` of at least 7 on every Dependabot ecosystem | yes |
| Cooldown (install) | `minimumReleaseAge` of at least 7 days in `bunfig.toml` | yes |
| Install scripts | `trustedDependencies` set explicitly, or `ignoreScripts` | yes |
| Frozen installs | every install in a workflow is frozen | yes |
| Advisories | some workflow audits; no open high/critical Dependabot alert | yes |
| Audit job | the audit runs on pull requests in its own job | by hand |
| Backlog | no Dependabot PR older than 30 days | yes |
| Exact pins | `syncpack lint` (or equivalent) in CI | by hand |

The automated rows are checked across every repository weekly by the
[drift check](https://github.com/danfry1/standards#the-baseline-and-the-drift-check).
