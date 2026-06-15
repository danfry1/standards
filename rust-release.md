# Rust release & distribution

The packaging/release baseline for a Rust CLI or TUI: ship one `git tag` to crates.io, GitHub Releases (prebuilt binaries), Homebrew, and Nix — with **no long-lived secrets anywhere**. Each control is independent; adopt them together for a hands-off, keyless pipeline. For the dependency- and CI-hardening controls shared with every repo (SHA-pinned actions, least-privilege permissions, committed lockfile), see [supply-chain.md](./supply-chain.md) — this doc covers the release-specific pieces and the Rust specifics.

## For an agent setting up a new tool

Read this top to bottom, then do the work in this order. Most of it you can automate; two steps **must** be done by a human in a browser — surface those clearly and don't try to fake them.

**You (the agent) can do directly:**
- Write `release.yml`, `ci.yml`, and `flake.nix` from the snippets here (fill in crate name, bin name, owner, targets): [rust-release.yml](./snippets/rust-release.yml), [rust-ci.yml](./snippets/rust-ci.yml).
- Set up `CHANGELOG.md` (§8) and the VHS demo scaffold (§9) — [demo.tape](./snippets/demo.tape), [record.sh](./snippets/record.sh).
- Resolve every action tag to a commit SHA and pin it (`gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`).
- Set the App ID variable once the human gives it to you: `gh variable set TAP_BUMP_APP_ID ...`.
- Verify: `cargo build`/`test`/`clippy`, `nix flake check`, YAML lint, and after a release, watch the run with `gh run watch`.

**Must be done by the human (browser-only) — give exact, copy-pasteable instructions and then wait:**
1. **crates.io Trusted Publishing** (§2) — there is no API for this; it's a settings page. Without it, `publish-crate` fails.
2. **Create + install the GitHub App** and download its private key (§4) — Apps can't be created from the CLI. You *can* store the resulting App ID + key with `gh` once the human hands them over.

**The split that matters:** never propose a Personal Access Token or a stored `CARGO_REGISTRY_TOKEN` — those are the anti-patterns this standard exists to avoid. crates.io = OIDC; cross-repo push = GitHub App. If a human pushes back on "another secret," explain the distinction in §4: an App stores only a private key that mints short-lived scoped tokens, which is categorically safer than a long-lived token.

Until both human steps are done, the workflow is still safe to merge — each unconfigured job just fails in isolation while the rest of the release succeeds.

## Principles

1. **Keyless.** No long-lived tokens in CI secrets. crates.io uses OIDC Trusted Publishing; cross-repo pushes use a GitHub App that mints a short-lived token at run time. The only stored secret is a GitHub App private key, and the tokens it produces expire in ~1 hour and are scoped to one repo.
2. **Tag-triggered.** A `vX.Y.Z` tag push runs the whole pipeline. Cutting a release is: bump the version + changelog, `git tag vX.Y.Z && git push --tags`.
3. **Single source of truth.** `Cargo.toml` is the only place the version lives — the Nix flake and the published artifacts all derive from it, so they can't drift.

## Pipeline overview

A tag push runs four jobs in `release.yml`:

| # | Job | What it does | Auth |
|---|---|---|---|
| 1 | `create-release` | Publish the GitHub Release (once, up front) | `GITHUB_TOKEN` (`contents: write`) |
| 2 | `upload` | Build per-target binaries + SHA-256 checksums, attach to the release | `GITHUB_TOKEN` (`contents: write`) |
| 3 | `publish-crate` | `cargo publish` to crates.io | **OIDC** — no stored token |
| 4 | `homebrew-bump` | Update the formula in the tap repo from the release checksums | **GitHub App** — short-lived token |

Nix needs no release job: consumers build from the flake, which tracks the tag/lockfile.

---

## 1. Tag-triggered release, version from `Cargo.toml`

`release.yml` triggers only on version tags, with a read-only permission floor that each job opts out of as needed:

```yaml
on:
  push:
    tags: ["v*"]

permissions:
  contents: read   # floor; jobs elevate per-scope
```

The flake reads the version from `Cargo.toml` so it never needs a manual bump (see §5). Net result: the **only** edit a release requires besides the changelog is `version = "..."` in `Cargo.toml`.

## 2. crates.io via OIDC Trusted Publishing

Don't store a `CARGO_REGISTRY_TOKEN`. Configure Trusted Publishing once, then the job mints a short-lived, crate-scoped token from the job's OIDC identity.

**One-time setup:** on crates.io → the crate's **Settings → Trusted Publishing** → add a GitHub publisher with Repository owner, Repository name, and Workflow filename (`release.yml`); leave Environment blank.

```yaml
publish-crate:
  name: Publish to crates.io
  runs-on: ubuntu-latest
  permissions:
    contents: read
    id-token: write   # mint the crates.io token via OIDC
  steps:
    - uses: actions/checkout@<sha> # v5
      with: { persist-credentials: false }
    - uses: dtolnay/rust-toolchain@<sha> # stable
    - uses: rust-lang/crates-io-auth-action@<sha> # v1.0.4
      id: auth
    - run: cargo publish --locked
      env:
        CARGO_REGISTRY_TOKEN: ${{ steps.auth.outputs.token }}
```

`--locked` publishes exactly what the committed `Cargo.lock` resolves. Trusted Publishing works for any crate you already own (including first publish once the crate exists).

## 3. GitHub Releases — binaries + checksums

Use the `taiki-e` actions: create the release once up front, then a matrix builds and attaches one archive + `.sha256` per target. The upload action does **not** create the release itself, so `create-release` must run first.

```yaml
create-release:
  runs-on: ubuntu-latest
  permissions: { contents: write }
  steps:
    - uses: actions/checkout@<sha> # v5
      with: { persist-credentials: false }
    - uses: taiki-e/create-gh-release-action@<sha> # v1
      with: { token: ${{ secrets.GITHUB_TOKEN }} }

upload:
  name: ${{ matrix.target }}
  needs: create-release
  runs-on: ${{ matrix.os }}
  permissions: { contents: write }
  strategy:
    fail-fast: false
    matrix:
      include:
        - { target: x86_64-unknown-linux-gnu, os: ubuntu-latest }
        - { target: aarch64-unknown-linux-gnu, os: ubuntu-latest }
        - { target: aarch64-apple-darwin, os: macos-14 }
        - { target: x86_64-pc-windows-msvc, os: windows-latest }
  steps:
    - uses: actions/checkout@<sha> # v5
      with: { persist-credentials: false }
    - uses: dtolnay/rust-toolchain@<sha> # stable
      with: { targets: ${{ matrix.target }} }
    - uses: taiki-e/upload-rust-binary-action@<sha> # v1
      with:
        bin: <crate-name>
        target: ${{ matrix.target }}
        archive: $bin-$target           # e.g. <crate>-aarch64-apple-darwin.tar.gz
        checksum: sha256
        token: ${{ secrets.GITHUB_TOKEN }}
```

> **Apple Silicon only.** The `macos-13` (Intel) runner queues unreliably; ship `aarch64-apple-darwin` and tell Intel-Mac users to `cargo install`. Document this so the gap reads as deliberate.

## 4. Homebrew formula bump via a GitHub App

Pushing to a **separate** tap repo (`<owner>/homebrew-tap`) needs a credential the default `GITHUB_TOKEN` can't provide, and GitHub Actions OIDC can't grant cross-repo *GitHub* writes. The keyless-token best practice is a **GitHub App**, not a PAT:

| Approach | Stored secret | Token lifetime | Best practice? |
|---|---|---|---|
| Personal Access Token | long-lived PAT | months | ❌ standing risk |
| **GitHub App** | App private key | **~1h, scoped** | ✅ **canonical** |
| Scheduled self-bump in the tap | none | tap's own `GITHUB_TOKEN` | ⚠️ secretless, but a workaround (polling lag) |
| Manual bump | none | — | fine for low release cadence |

A GitHub App stores only a *private key*; the actual tokens are minted per run, expire in ~1h, and are scoped to the tap + `contents`. That removes the standing-token risk a PAT carries.

**One-time setup:**
1. Create a GitHub App (Settings → Developer settings → GitHub Apps → New). Uncheck Webhook → Active. Repository permissions → **Contents: Read and write** (Metadata: Read-only is added automatically). Install on this account only.
2. Generate a **private key** (`.pem`) — this is the App's *private key*, not the OAuth client secret.
3. **Install** the App on the `<owner>/homebrew-tap` repo (Install App → Only select repositories). The App does **not** need installing on the source repo.
4. Store the **App ID** as the repo variable `TAP_BUMP_APP_ID` and the private key as the secret `TAP_BUMP_APP_PRIVATE_KEY`:
   ```sh
   gh variable set TAP_BUMP_APP_ID --repo <owner>/<repo> --body "<app-id>"
   gh secret set TAP_BUMP_APP_PRIVATE_KEY --repo <owner>/<repo> < ./app.private-key.pem
   rm ./app.private-key.pem   # regenerate from App settings if you ever rotate
   ```

```yaml
homebrew-bump:
  name: Bump Homebrew formula
  needs: upload
  runs-on: ubuntu-latest
  permissions:
    contents: read   # read this release's assets; the tap push uses the App token
  steps:
    - name: Mint a tap token from the GitHub App
      id: app-token
      uses: actions/create-github-app-token@<sha> # v3.2.0
      with:
        app-id: ${{ vars.TAP_BUMP_APP_ID }}
        private-key: ${{ secrets.TAP_BUMP_APP_PRIVATE_KEY }}
        owner: <owner>
        repositories: homebrew-tap

    - name: Check out the tap
      uses: actions/checkout@<sha> # v5
      with:
        repository: <owner>/homebrew-tap
        token: ${{ steps.app-token.outputs.token }}
        path: tap

    - name: Update the formula from the release checksums
      env:
        TAG: ${{ github.ref_name }}         # via env, never inlined into shell
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        REPO: ${{ github.repository }}
      run: |
        set -euo pipefail
        version="${TAG#v}"
        gh release download "$TAG" --repo "$REPO" --pattern '*.sha256' --dir shas
        sha() { awk '{print $1}' "shas/<crate>-$1.sha256"; }
        mac=$(sha aarch64-apple-darwin)
        lx64=$(sha x86_64-unknown-linux-gnu)
        larm=$(sha aarch64-unknown-linux-gnu)
        formula=tap/<crate>.rb
        awk -v ver="$version" -v mac="$mac" -v lx64="$lx64" -v larm="$larm" '
          /^  version / { print "  version \"" ver "\""; next }
          /url "/ {
            gsub(/download\/v[0-9.]+\//, "download/v" ver "/")
            if      ($0 ~ /aarch64-apple-darwin/)      pend = mac
            else if ($0 ~ /x86_64-unknown-linux-gnu/)  pend = lx64
            else if ($0 ~ /aarch64-unknown-linux-gnu/) pend = larm
            print; next
          }
          /sha256 "/ && pend != "" {
            sub(/sha256 "[^"]*"/, "sha256 \"" pend "\"")
            print; pend = ""; next
          }
          { print }
        ' "$formula" > "$formula.new"
        mv "$formula.new" "$formula"

    - name: Commit and push as the App bot
      env:
        TAG: ${{ github.ref_name }}
        GH_TOKEN: ${{ steps.app-token.outputs.token }}
        APP_SLUG: ${{ steps.app-token.outputs.app-slug }}
      run: |
        set -euo pipefail
        cd tap
        if git diff --quiet; then echo "Already up to date."; exit 0; fi
        bot_id=$(gh api "/users/${APP_SLUG}[bot]" --jq .id)
        git config user.name "${APP_SLUG}[bot]"
        git config user.email "${bot_id}+${APP_SLUG}[bot]@users.noreply.github.com"
        git commit -am "Update <crate> to ${TAG#v}"
        git push
```

**Why a checksum-driven `awk` rewrite, not a bump action.** A hand-written binary formula has *one `url`/`sha256` block per platform* (macOS-arm + two Linux). The common single-tarball bump actions (`mislav/bump-homebrew-formula`, `dawidd6/action-homebrew-bump-formula`) only handle a source tarball, so they can't update a multi-platform formula. Reading the hashes straight from the release's `.sha256` assets also guarantees the formula can never drift from what was actually published.

**Gotcha — sha-to-platform mapping.** The `awk` keys each `sha256` to the archive named in the `url` line *above* it. Keep the formula's `url` lines ordered as written and the archive base name (`<crate>`) in sync with the upload action's `archive: $bin-$target`.

## 5. Nix flake best practices

```nix
{
  description = "<one-line description>";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = import nixpkgs { inherit system; };
        # Single source of truth: read name/version/metadata from Cargo.toml so
        # the flake never drifts and needs no manual bump on release.
        cargoToml = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).package;
      in
      {
        packages.default = pkgs.rustPlatform.buildRustPackage {
          pname = cargoToml.name;
          inherit (cargoToml) version;
          src = ./.;
          cargoLock.lockFile = ./Cargo.lock;   # reproducible; no vendored hash
          strictDeps = true;                    # correct under cross-compilation
          meta = {
            inherit (cargoToml) description homepage;
            license = pkgs.lib.licenses.mit;
            mainProgram = cargoToml.name;
          };
        };
        apps.default = flake-utils.lib.mkApp { drv = self.packages.${system}.default; };
        # `nix flake check` builds the package (runs the test suite via the check phase).
        checks.default = self.packages.${system}.default;
        # `nix fmt`
        formatter = pkgs.nixfmt-rfc-style;
        devShells.default = pkgs.mkShell {
          packages = [ pkgs.cargo pkgs.rustc pkgs.clippy pkgs.rustfmt pkgs.rust-analyzer ];
        };
      }
    );
}
```

- **Derive everything from `Cargo.toml`** (`pname`, `version`, `description`, `homepage`) — kills version drift between the crate and the flake.
- **`cargoLock.lockFile = ./Cargo.lock`** — reproducible from the committed lockfile; no `cargoHash` to maintain.
- **`strictDeps = true`** — keeps build-time and host tool closures distinct for cross-compilation.
- **`checks.default` + `formatter`** — wires up `nix flake check` and `nix fmt`.
- Track `nixos-unstable` when the crate uses a recent edition/`rust-version` newer than the current stable channel ships.
- Commit `flake.lock`.

## 6. Crate packaging & Cargo hygiene

- **Commit `Cargo.lock`** even for libraries here (these are shipped binaries); publish with `cargo publish --locked`.
- **Pin direct deps to a minor series**; the committed lockfile pins the full transitive tree to exact versions + checksums.
- **Pure-Rust TLS** (`rustls`), not `native-tls`/OpenSSL — no system linkage. When the tool must work behind corporate proxies, use reqwest's `rustls-tls-native-roots` so the OS trust store is honored.
- **Trim the published crate** with `exclude = ["demo/", ".github/", "CHANGELOG.md"]` — ship only what's needed to build.
- **`cargo audit` in CI** (`taiki-e/install-action` with `tool: cargo-audit`) on every push.
- Reproducible release profile: `strip = true`, `lto = true`, `codegen-units = 1`, `panic = "abort"`.

## 7. CI workflow (`ci.yml`)

Every push and PR runs format + clippy (warnings as errors) + tests, plus a separate `cargo audit` job. Read-only permissions; SHA-pinned actions; `rust-cache` for speed. Copy-paste in [snippets/rust-ci.yml](./snippets/rust-ci.yml). The essentials:

```yaml
name: CI
on: { push: { branches: [main] }, pull_request: {} }
permissions:
  contents: read
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
env:
  CARGO_TERM_COLOR: always
  RUSTFLAGS: -D warnings        # warnings fail the build everywhere, not just clippy
jobs:
  check:    # fmt --check, clippy --all-targets -D warnings, test --all (+ Swatinem/rust-cache)
  audit:    # taiki-e/install-action tool: cargo-audit, then `cargo audit`
```

`cargo audit` here is the runtime guard against advisories in the locked tree; it pairs with the Dependabot cooldown from [supply-chain.md §2](./supply-chain.md#2-dependency-update-cooldown).

## 8. Changelog & versioning

- **Semantic Versioning.** `0.x` while the surface is unstable; bump minor for features, patch for fixes.
- **Keep a Changelog.** Maintain `CHANGELOG.md` with an `## [Unreleased]` section that you rename to `## [X.Y.Z] - YYYY-MM-DD` at release. Group entries under `Added` / `Changed` / `Fixed` / `Removed`.
- **The version lives once** — in `Cargo.toml`. The flake derives it (§5); `Cargo.lock` updates on build; the Homebrew formula and crates.io get it from the tag/publish. So a release edit = `Cargo.toml` version + a changelog entry, then tag.
- Write changelog/commit/release text as neutral, third-person project documentation — what changed and why, for a stranger reading the repo.

## 9. Demo GIF (VHS)

Record a terminal demo with [VHS](https://github.com/charmbracelet/vhs) and embed it at the top of the README. Templates: [snippets/demo.tape](./snippets/demo.tape), [snippets/record.sh](./snippets/record.sh).

- `demo/demo.tape` drives the app; `demo/record.sh` builds `--release`, exports the binary path as an env var the tape types (`$<CRATE>_BIN`), and runs `vhs` from `demo/`.
- **VHS 0.11 quirk:** the tape needs a **bare** `Output <crate>.gif` (no directory path) — running vhs from `demo/` is what places it there.
- Commit `demo/<crate>.gif`; embed it raw so it renders on crates.io and GitHub:
  ```markdown
  ![<crate> demo](https://raw.githubusercontent.com/<owner>/<crate>/main/demo/<crate>.gif)
  ```
- The release crate excludes `demo/` (§6) so the multi-MB gif never ships to crates.io.

## 10. Shared CI hardening

Everything in [supply-chain.md §5–6](./supply-chain.md) applies to **both** `ci.yml` and `release.yml`: **SHA-pin every action** (version in a trailing comment), **least-privilege `permissions`** (read-only floor, elevate per job), and **never inline `github.*` into `run:`** — pass via `env:`. Also set `persist-credentials: false` on any checkout that doesn't push.

Rust-specific pinned actions (resolve a tag to its SHA with `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`):

| Action | Tag |
|---|---|
| `dtolnay/rust-toolchain` | `stable` (pin the branch's commit SHA) |
| `Swatinem/rust-cache` | v2 |
| `taiki-e/install-action` | v2 |
| `taiki-e/create-gh-release-action` | v1 |
| `taiki-e/upload-rust-binary-action` | v1 |
| `rust-lang/crates-io-auth-action` | v1.0.4 |
| `actions/create-github-app-token` | v3.2.0 |

A copy-paste `release.yml` with the SHAs filled in lives in [snippets/rust-release.yml](./snippets/rust-release.yml).

---

## Adoption checklist

- [ ] `release.yml` triggers on `tags: ["v*"]`, `permissions: contents: read` floor
- [ ] `publish-crate` uses OIDC (`id-token: write` + `crates-io-auth-action`); crates.io Trusted Publisher configured; **no `CARGO_REGISTRY_TOKEN`**
- [ ] `create-release` → `upload` matrix with `checksum: sha256`
- [ ] `homebrew-bump` uses a **GitHub App** token (`TAP_BUMP_APP_ID` var + `TAP_BUMP_APP_PRIVATE_KEY` secret); App installed on the tap; **no PAT**
- [ ] `flake.nix` derives `pname`/`version`/metadata from `Cargo.toml`; `strictDeps`, `checks`, `formatter`; `flake.lock` committed
- [ ] `Cargo.lock` committed; `cargo publish --locked`; deps pinned to a minor series
- [ ] `rustls` TLS (no OpenSSL); `cargo audit` in CI
- [ ] `ci.yml` runs fmt + clippy (`-D warnings`) + test + `cargo audit`, read-only permissions
- [ ] `CHANGELOG.md` (Keep a Changelog + SemVer); version edited only in `Cargo.toml`
- [ ] `demo/` VHS tape + `record.sh`; gif committed and embedded raw in the README; `demo/` excluded from the crate
- [ ] All actions SHA-pinned with `# vX` comments; least-privilege `permissions`; `persist-credentials: false` where nothing pushes; tag passed via `env:`
- [ ] A release is: bump `Cargo.toml` version + changelog → `git tag vX.Y.Z && git push --tags`
