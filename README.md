# standards

My engineering standards — the patterns I hold code to, written down precisely
enough to be enforceable. The throughline is the same everywhere: **make the bad
state impossible rather than merely caught**. In types, that means the compiler
proves correctness; in tests, it means every test pins real behavior and can
actually fail.

These are the patterns I apply across all my work, written down once so they're
consistent everywhere. Each standard is a self-contained, example-driven
document. The strongest ones graduate into
[Agent Skills](https://agentskills.io/specification) — portable `SKILL.md` files
that work across Claude Code, OpenCode, Codex, and any agent that reads the open
format.

## Standards

| Standard | What it covers |
| --- | --- |
| [**TypeScript**](typescript.md) | 27 rules for maximum, config-independent type strictness — discriminated unions, branded primitives, precise generics, `unknown` boundaries, `Result` over throwing; no `any`/`enum`/unchecked `as`. Each rule maps to the `tsconfig`/ESLint flag that locks it in. |
| [**Error handling**](error-handling.md) | 14 rules so no error is ever opaque — a caught value is never left as `unknown`, and a thrown value is never a bare `Error`. Typed custom errors with a literal discriminant, structured context, and preserved `cause`; narrow-don't-cast in `catch`; translate foreign errors at boundaries; one exhaustive top-level handler. |
| [**Testing**](testing.md) | 19 rules for tests that catch regressions instead of granting *fake safety* — exact assertions over truthiness, specific errors, determinism, isolation, behavior over implementation. For Vitest & Jest. |
| [**Supply-chain security**](supply-chain-security.md) | 16 rules for surviving a compromised dependency, action, or PR — dependency cooldowns, exact pinning, frozen lockfiles, default-deny install scripts, SHA-pinned GitHub Actions, least-privilege tokens, OIDC provenance. |

The load-bearing claims are checked against the real toolchain, not just
asserted: the type-level rules compile under `tsc --strict` (with the `❌` cases
confirmed to *fail* via `@ts-expect-error`), and the matcher-behavior claims
(`toEqual` vs `toStrictEqual`, truthiness) are proven with a real Vitest run.

## Skills

| Skill | What it does |
| --- | --- |
| [`typescript-strict`](skills/typescript-strict/SKILL.md) | The TypeScript standard as a working skill. **Authors** robust, config-independent TS and **reviews** any repo for type holes and strictness gaps via a zero-dep scanner, calibrated to the repo's config. Strict `tsconfig` + ESLint config ship as **optional** enforcement. |

## Layout

```
standards/
├── typescript.md              # the TypeScript standard
├── error-handling.md          # the error-handling standard
├── testing.md                 # the testing standard
├── supply-chain-security.md   # the supply-chain security standard
└── skills/
    └── <skill-name>/
        ├── SKILL.md       # required: frontmatter (name, description) + body
        ├── references/    # optional: deep-dive docs & droppable configs
        └── scripts/       # optional: deterministic helpers (e.g. repo scanners)
```

`SKILL.md` keeps the always-on rules; heavier detail lives in `references/` and
is loaded only when needed (progressive disclosure).

## Using the skills

**Claude Code** — symlink (or copy) a skill into a project's or your user skills
directory:

```bash
ln -s "$(pwd)/skills/typescript-strict" ~/.claude/skills/typescript-strict
```

**OpenCode** — reads `.claude/skills/`, `.opencode/skills/`, and
`.agents/skills/`. Point any of those at this repo:

```bash
ln -s "$(pwd)/skills/typescript-strict" .opencode/skills/typescript-strict
```

**Codex / other agents** — reference the `SKILL.md` (and its `references/`)
from wherever that tool loads instructions.

The skills are also directly usable as droppable configs: e.g.
`skills/typescript-strict/references/tsconfig.strict.json` and
`eslint.config.strict.mjs` can be extended by any TypeScript project.

## License

MIT — see [LICENSE](LICENSE).
