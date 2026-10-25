# Releasing standards

A standard for how artifacts leave a repository: npm packages, crates, binaries,
Homebrew formulae, GitHub Actions, and the security releases that fix them. The
threat model is a stolen publishing token, a release built from the wrong
commit, a tag moved after the fact, an artifact nobody can trace back to its
source, and a maintainer who approves something they never looked at.

The posture: **releases are tag-triggered, keyless and verifiable, and a human
decides what ships** - by approving a staged version where the channel supports
it, and by pushing the tag where it does not.

Reference implementations. Each is cited only for the part named, not as a
complete example: release workflows are reviewed by hand against this
standard, and several of these still have gaps (for example, wordle-tui's
publish job still compiles the crate next to the token, and the single-job
npm releases run tests where the token is available).

| Part | Reference |
| --- | --- |
| npm: build job, isolated stage-publish job, GitHub release | [`danfry1/reflow-ts` release.yml](https://github.com/danfry1/reflow-ts/blob/main/.github/workflows/release.yml) |
| crates.io trusted-publisher auth action; the tap pull request | [`danfry1/wordle-tui` release.yml](https://github.com/danfry1/wordle-tui/blob/main/.github/workflows/release.yml) |
| The attest job, verified against published checksums | [`danfry1/waxon` release.yml](https://github.com/danfry1/waxon/blob/main/.github/workflows/release.yml) |
| Homebrew tap: test-bot bottles, manual publish | [`danfry1/homebrew-tap`](https://github.com/danfry1/homebrew-tap) |
| A JavaScript action's reproducible `dist/` | [`danfry1/jev-triage` ci.yml](https://github.com/danfry1/jev-triage/blob/main/.github/workflows/ci.yml) |

Legend: ✅ do · ❌ avoid.

---

## Principles

### 1. Tag-triggered, from `main`, with one source of truth for the version

A release is a version tag pushed to a commit on `main`. The version lives in
exactly one place (`package.json`, `Cargo.toml`, or the tag itself for Go), and
the workflow fails if the tag and the manifest disagree
([GitHub Actions](github-actions.md#8-gate-releases-on-the-tag)).

### 2. Keyless publishing

No long-lived registry token exists anywhere: not in CI secrets, not on the
maintainer's machine. Registries that support it are published to with **OIDC
trusted publishing**; cross-repository writes use a **GitHub App** token
([GitHub Actions](github-actions.md#12-cross-repo-writes-use-a-github-app-token-never-a-pat)).

### 3. A human gate before anything ships

Where the channel supports it, CI builds, tests and *stages*, and a human
approves with 2FA: npm staged publishing, or a manually dispatched Homebrew
`pr-pull`. Where it does not (crates.io, binaries on a release, a Scoop
manifest), pushing the version tag is the human decision, and everything up
to that point must have run on the pull request. An automated release that
ships straight to `latest` makes every consumer the test.

### 4. Every artifact is traceable to its commit

npm and crates.io attach provenance through trusted publishing; binaries get a
build-provenance attestation; checksums are published next to every download.
Consumers can verify any artifact without trusting the maintainer's word.

### 5. Tags are permanent; fix forward

Release tags are locked by ruleset ([Repository](repository.md#3-rulesets-on-main-and-on-release-tags)).
A failed or bad release is fixed with a **new patch version**, never by moving
or re-using a tag. The one exception is a GitHub Action's major tag (`v1`),
which is a pointer by design.

### 6. Isolate the publishing job

The job that can publish downloads the artifact an earlier, read-only job built
and tested, and runs nothing else ([GitHub Actions](github-actions.md#7-split-build-from-publish)).

### 7. Verify after publishing

After every release, confirm from the outside what users get: the registry
shows the version with provenance, `latest` points where you expect, and the
installed artifact contains the change.

```bash
npm view <pkg> dist-tags versions --json
npm install <pkg>@<version> && npm audit signatures
gh attestation verify <file> --repo OWNER/REPO
```

---

## Channels

### npm

- **Trusted publisher** on npmjs.com: the repository, the workflow file, and
  the `npm` environment. Restrict it to **stage publish** where the package
  supports it.
- **Package setting:** "Require two-factor authentication and disallow tokens".
  Safe once every publish uses OIDC - check no workflow references
  `NPM_TOKEN`/`NODE_AUTH_TOKEN` and no such secret remains first.
- **Pin the npm that publishes** by pinning an exact Node version in the publish
  job (`node-version: 24.21.0`) whose bundled npm supports `npm stage`. The
  publish job then installs nothing. Jobs that don't publish may pin npm as a
  `devDependency` instead and put `node_modules/.bin` first on `PATH`.
- **Stage, then approve:**

  ```bash
  # in CI (OIDC, provenance generated automatically)
  npm stage publish
  # by the maintainer, with 2FA
  npm stage list
  npm stage download <id>    # inspect what will ship
  npm stage approve <id>
  ```

- **Skip versions already on the registry** (`npm view "<pkg>@$version"`), so
  re-running a release is safe.
- **The first publish** of a new name is a one-off bootstrap by hand with 2FA;
  every later version goes through CI. Remove any dist-tag left pointing at the
  bootstrap version.
- **Attach an SBOM** (CycloneDX) to the GitHub release.
- **A private repository cannot carry public provenance.** A package published
  from one should move to a public repository.

### crates.io

- **Trusted Publishing** on the crate's settings page (repository, workflow
  `release.yml`), then enable **"Require trusted publishing for all new
  versions"** so a leaked token could not publish either.
- **Verify in a read-only job, publish without building.** `cargo publish`
  normally verifies by compiling the crate, which runs dependencies' build
  scripts and proc macros - in the job that holds the token. Run
  `cargo package --locked` in a job with read-only permissions, then
  `cargo publish --locked --no-verify` in the publish job, so no dependency code
  runs next to the token.
- Mint the token per run with `rust-lang/crates-io-auth-action`.
- `cargo logout` on the maintainer's machine; no API tokens on the account.

```yaml
# ✅
verify-crate:
  runs-on: ubuntu-latest
  timeout-minutes: 20
  permissions:
    contents: read
  steps:
    - uses: actions/checkout@<sha> # vX.Y.Z
      with:
        persist-credentials: false
    - run: cargo package --locked   # builds and checks the exact package

publish-crate:
  needs: verify-crate
  runs-on: ubuntu-latest
  timeout-minutes: 10
  permissions:
    contents: read
    id-token: write
  steps:
    - uses: actions/checkout@<sha> # vX.Y.Z
      with:
        persist-credentials: false
    - uses: rust-lang/crates-io-auth-action@<sha> # v1.0.4
      id: auth
    - run: cargo publish --locked --no-verify   # verified above; nothing compiles here
      env:
        CARGO_REGISTRY_TOKEN: ${{ steps.auth.outputs.token }}
```

### Binaries on GitHub Releases

- Build per target in a matrix; publish an archive and a SHA-256 checksum per
  target.
- **Attest** in one job appended after the last upload, in the same run:
  download the published assets, check them against the published checksums,
  then attest with `actions/attest` and `subject-checksums`. Appending the job
  means attestation never needs threading through each build, and a failure
  there cannot block the rest of the release.
- **Never attest an old release** to test the job: an attestation claims "built
  by this run". Dry-run the download and checksum logic instead.
- Be exact about what checksums prove: checksums from the same release detect
  corruption or a partial swap, not a full swap. The attestation covers the
  full swap.

```yaml
# ✅ the appended attest job
attest:
  needs: [upload]
  runs-on: ubuntu-latest
  timeout-minutes: 15
  permissions:
    contents: read
    id-token: write       # sign (Sigstore)
    attestations: write   # store
  steps:
    - env:
        GH_TOKEN: ${{ github.token }}
        TAG: ${{ github.ref_name }}
      run: gh release download "$TAG" --repo "$GITHUB_REPOSITORY" --dir dist
    # ...verify against the published checksums, write subjects.txt...
    - uses: actions/attest@<sha> # v4.2.2
      with:
        subject-checksums: ${{ runner.temp }}/subjects.txt
```

Consumers verify with `gh attestation verify <file> --repo OWNER/REPO`.

### Homebrew

- **Formulae build from source** in a tap (`OWNER/homebrew-tap`) with
  `std_cargo_args` / `std_go_args`. Never ship a prebuilt, unsigned macOS binary
  in a cask that strips the quarantine attribute: that switches Gatekeeper off
  for that binary on every user's machine.
- **Bottles** remove the compile: the tap's `tests.yml` runs `brew test-bot` on
  each formula PR (macOS 15, Ubuntu x86_64, Ubuntu ARM - bottles built on the
  oldest supported macOS serve newer ones), and a **manually dispatched**
  `publish.yml` runs `brew pr-pull` to upload, attest and write the `bottle do`
  block. The dispatch is the human gate.
- **The release opens a PR, it does not push.** The tool's release job, using
  the GitHub App token, bumps `url`/`sha256`, deletes the stale `bottle do`
  block (and the blank line it leaves) and any `revision`, opens a PR on the tap,
  and comments the exact publish command.
- **Real tests.** `test do` exercises behaviour offline (config paths, a
  failure message that names the fix, a TUI driven in a pseudo-terminal) instead
  of `--version`. Prove each test can fail.
- **Run homebrew-core's audit** (`brew audit --new --strict --online`) in the
  tap's CI so a formula is ready to submit upstream when the project qualifies.
- **Moving a cask to a formula:** delete the cask and add
  `tap_migrations.json` (`{"tool": "OWNER/tap"}`). Homebrew migrates users on
  the next `brew update`. Stop the release tool regenerating the cask *before*
  deleting it, or the next release brings it back.

### Scoop

The release pushes the manifest to the bucket with the same GitHub App token
used for the tap; nothing else holds write access to the bucket.

### JavaScript GitHub Actions

- Commit `dist/` and check in CI that a fresh build reproduces it byte for byte
  (`git diff --exit-code dist/`), so the committed bundle is provably the
  source.
- A runtime dependency fix is a release: rebuild `dist/`, tag `vX.Y.Z`, publish
  release notes, then move the major tag (`v1`) to the same commit so
  `@v1` users get it.

---

## Security releases

When a vulnerability is confirmed:

1. **Fix with a regression test** that fails without the fix; add a property or
   fuzz comparison against the reference behaviour where one exists.
2. **Decide where to fix.** If the bug is already public (a failing CI log, a
   public issue), fix in the open. Otherwise use the advisory's private fork.
3. **Release a patch version** through the normal pipeline, then verify the
   published artifact contains the fix.
4. **Publish a GitHub security advisory**: summary, impact, affected range,
   patched version, severity, CWE, and workarounds. Dependabot then alerts every
   affected user. Request a CVE if the package has users outside your own repos.
5. **Remove dist-tags that still point at vulnerable versions.**
6. **Credit the reporter** if they want it.

---

## Enforcement

| Rule | Check | Automated |
| --- | --- | --- |
| Keyless | no repository, Dependabot or environment secret looks like a registry token or PAT | yes |
| npm | each package requires 2FA and disallows tokens; trusted publisher configured | by hand |
| crates.io | "require trusted publishing" enabled | by hand |
| Tag gate | the release checks tag == version, on `main`, not already published | by hand |
| Isolated publish | the job with `id-token: write` builds and tests nothing | by hand |
| Attestation | binary releases publish checksums and run an attest job | by hand |
| Homebrew | tap CI green; formulae build from source; no quarantine-stripping casks | by hand |
| Stale tags | no dist-tag points below the latest patched version | by hand |
