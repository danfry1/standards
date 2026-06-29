---
name: typescript-strict
description: >-
  Write, review, and harden TypeScript at maximum type strictness. Use for ANY
  task that authors, edits, audits, or reviews TypeScript — even when the user
  doesn't say "strict". As a REVIEWER: drop into any repo to flag type holes and
  strictness gaps (any, unchecked `as`/`!`, enum, JSON.parse-as-T, illegal-state
  unions, non-exhaustive switches, bare-primitive IDs), calibrated to that
  repo's own config and house style — bugs first, not style nits. As an AUTHOR:
  produce robust, config-independent TS — `as const satisfies` over loose
  Record, string/template-literal types over `string`, discriminated unions with
  exhaustiveness, branded primitives, precise generics; no any/enum/unchecked-as.
  Trigger on .ts/.tsx, tsconfig, code review or audit requests, "is this
  type-safe", "flag type issues", "make this robust", or new TS scaffolds.
license: MIT
metadata:
  version: "1.0"
  language: typescript
---

# TypeScript: Maximum Strictness

Default posture: **the most precise type the compiler can be made to prove.**
A type that admits illegal states is a bug, even if the code runs. Prefer
designs where bad states are *unrepresentable* over designs where they are
merely *validated*.

When writing or reviewing TypeScript, apply the rules below in order. Each rule
has a ✅/❌ pair. The exhaustive catalog with edge cases lives in
[references/patterns.md](references/patterns.md) — read it when a rule needs
deeper treatment (branding strategies, variance, conditional/mapped types,
type-level testing).

**These patterns are config-independent.** Every example here is robust
TypeScript that compiles and passes linting under *any* reasonable config —
strict flags on or off, ESLint relaxed or maximal. Strictness here is a
property of the *types you write*, not flags you impose. Apply them by default
in any repo, including one you don't own; match the house style and let the
patterns carry the strictness.

---

## 0. Optional: lock it in with config (projects you own)

The patterns stand on their own. But if you own the project and want the
compiler/linter to *mechanically prevent regressions*, adopt the bundled
configs: [references/tsconfig.strict.json](references/tsconfig.strict.json) and
[references/eslint.config.strict.mjs](references/eslint.config.strict.mjs).

This earns two guarantees that careful authoring **cannot** give you on its own,
because they are the one place patterns fall short — and note `strict: true`
does *not* enable either:

- `noUncheckedIndexedAccess` — makes `arr[i]` / `obj[key]` return `T | undefined`,
  so an unguarded access becomes a compile error rather than a latent crash.
- `exactOptionalPropertyTypes` — keeps `{ x: undefined }` from silently
  satisfying `x?: number`.

The code you write is robust either way; these flags stop the *next* person from
regressing it. Never force config onto a repo you don't own.

---

## 1. `as const satisfies` — never a loose `Record`

A `Record<string, T>` throws away the keys and widens values. `as const`
preserves the exact literal shape; `satisfies` checks it against a constraint
*without widening*. Use both together: **`as const satisfies`**.

```ts
// ❌ keys erased, values widened — `routes.home` is `string`, any key "type-checks"
const routes: Record<string, string> = { home: "/", user: "/users/:id" };

// ✅ keys + literal values preserved AND constrained
const routes = {
  home: "/",
  user: "/users/:id",
} as const satisfies Record<string, `/${string}`>;
//        routes.home is "/", typeof keys is "home" | "user"

type RouteName = keyof typeof routes;        // "home" | "user"
type RoutePath = (typeof routes)[RouteName]; // "/" | "/users/:id"
```

Rule: a config/lookup object gets `as const satisfies <Constraint>`. The
constraint catches mistakes; the `as const` keeps the literals for downstream
types. Annotating the variable (`: Record<...>`) instead is the anti-pattern —
it widens.

## 2. String-literal & template-literal types over `string`

`string` is the `any` of the string world. If the set of legal values is known,
make it a union. If values follow a shape, encode the shape as a template
literal.

```ts
// ❌
function track(event: string): void {}

// ✅ closed set
type AnalyticsEvent = "page_view" | "sign_up" | "purchase";
function track(event: AnalyticsEvent): void {}

// ✅ shape encoded — only `${number}px` / `${number}rem` accepted
type CssLength = `${number}px` | `${number}rem` | `${number}%`;

// ✅ derive, never hand-maintain, parallel unions
type HttpMethod = "get" | "post" | "put" | "delete";
type Handlers = { [M in HttpMethod as `on${Capitalize<M>}`]: () => void };
// { onGet: ..., onPost: ..., onPut: ..., onDelete: ... }
```

## 3. Model with discriminated unions; check exhaustively

An object whose valid fields depend on a mode is a discriminated union, not a
bag of optionals. Close every `switch` over the discriminant with a `never`
exhaustiveness guard so adding a variant becomes a compile error.

```ts
// ❌ illegal states representable: { status: "success", error: "..." }
type Result = { status: string; data?: User; error?: string };

// ✅ each variant carries exactly its own fields
type Result =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: User }
  | { readonly status: "error"; readonly error: Error };

function render(r: Result): string {
  switch (r.status) {
    case "loading": return "…";
    case "success": return r.data.name; // `data` known to exist here
    case "error":   return r.error.message;
    default: return assertNever(r);     // compile error if a variant is unhandled
  }
}
export function assertNever(x: never): never {
  throw new Error(`Unhandled case: ${JSON.stringify(x)}`);
}
```

## 4. Brand primitives that aren't interchangeable

A `UserId` and an `OrderId` are both strings but must never be assigned across.
Use a branded (nominal) type so the compiler enforces provenance. See
[references/patterns.md](references/patterns.md) § Branding for the smart-
constructor pattern.

```ts
// ❌ swappable — order of args silently wrong
function transfer(from: string, to: string, amount: number): void {}

// ✅
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

type UserId = Brand<string, "UserId">;
type Cents  = Brand<number, "Cents">;

function transfer(from: UserId, to: UserId, amount: Cents): void {}
// transfer("a", "b", 100) ❌  — raw strings/numbers rejected; must go through a validator
```

## 5. Precise generics — constrain, infer, and control widening

Generics exist to *relate* types, not to accept anything. Constrain every type
parameter. Let inference flow from arguments. Use `const` type parameters to
preserve literals, and `NoInfer<T>` to stop a parameter from being inferred
from the wrong site.

```ts
// ❌ `any` in disguise
function first(arr: any[]): any { return arr[0]; }

// ✅ relates input element type to output; `T[number] | undefined` honors
//    noUncheckedIndexedAccess
function first<const T extends readonly unknown[]>(arr: T): T[number] | undefined {
  return arr[0];
}

// ✅ NoInfer pins the default source — `fallback` can't widen `T`
function withDefault<T>(value: T | undefined, fallback: NoInfer<T>): T {
  return value ?? fallback;
}
```

Pick the typed overload-free path: prefer one generic signature over multiple
overloads when a conditional return type expresses the relationship (see
patterns.md § Generics & inference).

## 6. No `enum` — use `as const` objects + a derived union

`enum` emits runtime code, has nominal/structural quirks, and `const enum`
breaks under `isolatedModules`. An `as const` object plus a derived union is
purely structural, tree-shakeable, and gives you both the values and the type.

```ts
// ❌
enum Role { Admin, User, Guest }

// ✅
const Role = { Admin: "admin", User: "user", Guest: "guest" } as const;
type Role = (typeof Role)[keyof typeof Role]; // "admin" | "user" | "guest"
```

## 7. Ban the escape hatches

- **`any` → `unknown`.** Accept `unknown` at boundaries, then narrow with a type
  guard or assertion function. `any` disables checking transitively.
- **`as T` is a last resort.** The only freely-allowed assertion is `as const`.
  To go from `unknown` to a concrete type, narrow with a *validated* type
  predicate (`x is T`) or an assertion function (`asserts x is T`) — not a cast.
- **No non-null `!`.** Narrow instead, or prove non-null via control flow.

```ts
// ❌
const user = JSON.parse(body) as User;

// ✅ runtime validation that also narrows the static type
function isUser(x: unknown): x is User {
  return typeof x === "object" && x !== null
    && "id" in x && typeof (x as { id: unknown }).id === "string";
}
const parsed: unknown = JSON.parse(body);
if (!isUser(parsed)) throw new Error("bad payload");
parsed; // User
```

(For non-trivial shapes, reach for a schema validator — Zod/Valibot/ArkType —
and derive the static type from the schema with `z.infer`. One source of truth.)

## 8. `readonly` by default

Immutability is a stricter, safer type. Mark fields `readonly`, accept
`readonly T[]` / `ReadonlyArray<T>` in parameters you don't mutate, and use
`as const` for literal data. Widen to mutable only where mutation is the point.

```ts
// ✅
function sum(xs: readonly number[]): number { return xs.reduce((a, b) => a + b, 0); }
type Config = { readonly retries: number; readonly endpoints: readonly string[] };
```

---

## Review mode — flag issues in any repo without the noise

This skill drops into any TypeScript repo to surface real problems. The failure
mode to avoid is dumping 200 style nits and burying the 3 actual bugs. Work in
this order.

### 1. Calibrate to the repo first (before flagging anything)

- Read `tsconfig.json` and follow `extends`. Which strict flags are **on**? The
  compiler already catches those — don't re-report them. Which are **off** (esp.
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`) tells you which gaps
  are latent rather than compiler-enforced.
- Sample a few files for house style: `type` vs `interface`, named vs default
  exports, naming, which validation library is in use. **Match it.** A
  consistent local convention is not a finding.
- If it builds, skim `tsc --noEmit` — start from what the compiler already says.

### 2. Scan for the high-signal escape hatches

Run the bundled scanner for a fast, deterministic first pass:

```
node scripts/scan-escape-hatches.mjs <dir>     # add --json for machine output
```

It lists `file:line` hits for `any`, non-`const` `as`, `enum`, `JSON.parse`,
`@ts-ignore`/`@ts-expect-error`, and loose `Record<string, …>`. It is a
heuristic pre-filter — verify each hit in context; some are legitimate.

### 3. Triage by severity — lead with bugs, not taste

- **Type hole (bug — always flag):** `any`; unchecked `as`/`!`; `JSON.parse`
  typed as `T`; `@ts-ignore`; illegal states representable; non-exhaustive
  `switch`; a type predicate that doesn't actually prove its claim. Correctness
  risks.
- **Strictness gap (flag with a fix):** `: string`/`: number` where a union or
  template literal fits; `Record<string, …>` annotation that should be
  `as const satisfies`; bare primitives for IDs/money/timestamps → brand them;
  optional-field bag that should be a discriminated union; unconstrained `<T>`.
- **Style / idiom (mention only if it compounds a real bug, or they ask):**
  `enum` vs `as const` object; `type` vs `interface`; default vs named exports;
  mutable params never mutated. Match house style; don't moralize.

### 4. Report

Group by severity, lead with bugs, give `file:line` + the specific fix (cite the
relevant rule above or section in [references/patterns.md](references/patterns.md)).
If there are many of one kind, show the worst few with a count — don't list all
80. Offer the opt-in configs (§0) only when they own the repo, never impose them.

For anything subtle, consult [references/patterns.md](references/patterns.md)
before proposing a change.
