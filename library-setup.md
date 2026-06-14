# Library setup baseline

The packaging, build, and release conventions for a TypeScript library, complementing [supply-chain.md](./supply-chain.md). These make a library trustworthy to *install*: correct types, dual module formats, reproducible builds, and a sane release flow.

## Toolchain

- **Bun** as package manager + test runner (pin the version via `packageManager` in `package.json`).
- **tsdown** (rolldown-based) for builds — emits ESM + CJS + `.d.ts`/`.d.cts` from one entry.
- **oxlint** for linting (fast); **tsc --noEmit** for typechecking.

## Package.json essentials

```jsonc
{
  "type": "module",
  "sideEffects": false,
  "engines": { "node": ">=18.0.0" },     // state your real floor; CI must test it
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "publishConfig": { "access": "public" },
  "repository": { "type": "git", "url": "...", "directory": "packages/x" },
  "homepage": "...",
  "bugs": "https://github.com/<owner>/<repo>/issues",
  "exports": {
    ".": {
      "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
    }
  },
  "prepublishOnly": "bun run lint:deps && bun run typecheck && bun run test && bun run build"
}
```

Notes:
- **Separate `.d.ts` and `.d.cts`** for the ESM/CJS conditions — avoids the dual-package types hazard.
- **`prepublishOnly`** is the last-line safety net for manual publishes; mirror its checks in CI.
- A **CLI** package's `bin` must point at a built `dist/*.js` with a `#!/usr/bin/env node` shebang — never a raw `.ts`. Declare heavy runtime tools (e.g. `typescript`) as real `dependencies`, kept external by the bundler.

## Validate the published shape

Run [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io) against the packed tarball in CI to catch broken `exports`/types before release:

```yaml
- working-directory: packages/x
  run: npm pack && npx @arethetypeswrong/cli ./*.tgz --ignore-rules no-resolution
```

Also dry-run `npm pack` to confirm the tarball contains only `files` (no source/tests leak).

## Coverage gate

Make the test runner enforce a floor so coverage can't silently rot. Bun:

```toml
# bunfig.toml (in the package)
[test]
coverage = true
coverageThreshold = { line = 0.9, function = 0.9 }
```

## Node-version compatibility matrix

Tests usually run under Bun, which doesn't prove the *published artifact* works on your supported Node range. Add a job that builds, then smoke-loads the build under each supported Node:

```yaml
node-compat:
  strategy: { fail-fast: false, matrix: { node-version: [18, 20, 22] } }
  steps:
    - uses: actions/checkout@<sha> # v6
    - uses: oven-sh/setup-bun@<sha> # v2
    - run: bun install --frozen-lockfile
    - run: bun run build
    - uses: actions/setup-node@<sha> # v6.4.0
      with: { node-version: '${{ matrix.node-version }}' }
    - run: |
        node -e "require('./dist/index.cjs')"                       # CJS loads
        node --input-type=module -e "await import('./dist/index.js')" # ESM loads
```

## Releases — Changesets

Use [Changesets](https://github.com/changesets/changesets) for versioning + changelogs (works for single-package and monorepos):

- Contributors add a changeset (`bunx changeset`) describing user-facing changes.
- On push to `main`, a workflow opens a **"Version Packages" PR** that bumps versions + writes per-package `CHANGELOG.md`.
- Merging that PR publishes to npm (with provenance, see [supply-chain.md §8](./supply-chain.md#8-publish-provenance)).

This requires the repo setting **Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests"** (the action opens the version PR with `GITHUB_TOKEN`). Pre-1.0, treat breaking changes as `minor`.

## Repo hygiene

`LICENSE`, `SECURITY.md` (linking [supply-chain.md](./supply-chain.md)), `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `CODEOWNERS`, and issue/PR templates. README badges (npm version, CI, license) give first-time visitors a fast trust read.
