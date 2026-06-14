# standards

My engineering baseline for TypeScript libraries — supply-chain hardening, packaging, and release practices, in one place so individual repos can point here instead of copying each other.

Used by [bonsai-js](https://github.com/danfry1/bonsai-js), [reflow-ts](https://github.com/danfry1/reflow-ts), and [faultline](https://github.com/danfry1/faultline).

## Contents

- **[supply-chain.md](./supply-chain.md)** — the security baseline: release-age gate, dependency cooldown, exact pinning (syncpack), SHA-pinned actions, least-privilege CI, provenance, CodeQL + Scorecard. Each control has the rationale and a copy-paste snippet.
- **[library-setup.md](./library-setup.md)** — the packaging/release baseline: Bun workspaces, tsdown builds, dual ESM/CJS exports, `attw` export validation, a coverage gate, a Node-version compatibility matrix, and Changesets releases.
- **[snippets/](./snippets)** — ready-to-copy config files (`bunfig.toml`, `.syncpackrc.json`, `dependabot.yml`).
- **[.github/workflows/](./.github/workflows)** — **reusable** workflows (`workflow_call`) for CodeQL and Scorecard, so each repo invokes them in a few lines instead of duplicating them.

## How a repo adopts this

1. **Reusable workflows** — call them (see [supply-chain.md § Automated scanning](./supply-chain.md#7-automated-scanning)):

   ```yaml
   # .github/workflows/codeql.yml
   name: CodeQL
   on:
     push: { branches: [main] }
     pull_request: { branches: [main] }
     schedule: [{ cron: '0 6 * * 1' }]
   permissions: read-all
   jobs:
     codeql:
       permissions:
         security-events: write
         contents: read
       uses: danfry1/standards/.github/workflows/codeql.yml@v1
   ```

2. **Per-repo config** — copy from [snippets/](./snippets). GitHub can't share `bunfig.toml`, `dependabot.yml`, or `.syncpackrc.json` centrally, so these live in each repo.

3. **Link back** — point the repo's `SECURITY.md` at [supply-chain.md](./supply-chain.md) instead of re-explaining.

## Versioning

Tagged `v1`, `v2`, … Reusable workflows are referenced by tag (`@v1`). Because these workflows live in a repo I control, a tag here is trusted; third-party actions inside them are still SHA-pinned.

## License

MIT
