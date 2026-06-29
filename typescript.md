# TypeScript standards

A precise, opinionated standard for writing TypeScript where **illegal states are
unrepresentable** and the compiler — not code review — is what proves the code
correct. The posture is constant: reach for the *narrowest type the compiler can
prove*, and design types so a bug fails to compile rather than at runtime.

Every rule is config-independent — each example compiles and stays strict under
any reasonable `tsconfig`. The [Enforcement](#enforcement--compiler--lint-flags)
section lists the flags that mechanically lock the rules in on a project you own.

Legend: ✅ preferred · ❌ avoid.

---

## Core rules

### 1. Strictest type the compiler can prove — never widen on purpose

The default posture: the *narrowest* type that's still true. A type that admits
illegal states is a bug even if the code runs. Treat `string`, `number`,
`object`, and `any` as smells when something more specific is knowable.

### 2. Return types must not widen past what the body proves

If a function can only return `0` or `1`, its return type is `0 | 1`, **not**
`number`. Don't hand-annotate a wider type than the body produces, and don't let
inference widen — annotate the narrow literal union, or let inference keep it.

```ts
// ❌ return type widened to `number`
function toBit(on: boolean): number {
  return on ? 1 : 0;
}

// ✅ caller gets `0 | 1` and can use it in a literal-typed context
function toBit(on: boolean): 0 | 1 {
  return on ? 1 : 0;
}

// ✅ also fine: let inference keep it narrow (no annotation widening it)
const toBit = (on: boolean) => (on ? 1 : 0); // inferred: (on: boolean) => 0 | 1
```

Same idea for string-returning functions (`"asc" | "desc"`, not `string`) and
for objects (return the exact shape, not a widened interface).

### 3. `as const` + `satisfies`, together, for config/lookup data

`as const` preserves the exact literal shape; `satisfies` checks it against a
constraint *without widening*. Annotating with `: Record<...>` is the
anti-pattern — it erases keys and widens values.

```ts
// ❌ keys erased, values widened
const routes: Record<string, string> = { home: "/", user: "/users/:id" };

// ✅ literals + keys preserved AND constrained
const routes = {
  home: "/",
  user: "/users/:id",
} as const satisfies Record<string, `/${string}`>;
type RouteName = keyof typeof routes; // "home" | "user"
```

### 4. Literal & template-literal types over `string`

`string` is the `any` of strings. Closed set → union. Shaped value (URLs, ids,
css lengths, event names) → template literal.

```ts
type Method = "get" | "post" | "put" | "delete";
type CssLength = `${number}px` | `${number}rem` | `${number}%`;
type ApiUrl = `https://api.example.com/${string}`;
```

Prefer template literals for anything assembled from parts (URLs, keys, class
names) so the shape is enforced and the pieces stay derivable.

### 5. Objects typed as strictly as possible

No bag-of-optionals when the valid fields depend on a mode — that's a
discriminated union. Mark fields `readonly` by default. Don't reach for an
index signature when the keys are known.

```ts
// ❌ illegal states representable: { status: "success", error: "..." }
type Result = { status: string; data?: User; error?: string };

// ✅ each variant carries exactly its own fields
type Result =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: User }
  | { readonly status: "error"; readonly error: Error };
```

### 6. Exhaustiveness with `never`

Close every `switch`/match over a discriminant with an `assertNever` so adding a
variant becomes a compile error.

```ts
function render(r: Result): string {
  switch (r.status) {
    case "loading": return "…";
    case "success": return r.data.name;
    case "error":   return r.error.message;
    default:        return assertNever(r);
  }
}
const assertNever = (x: never): never => {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`);
};
```

### 7. Generics and conditional types wherever they relate things

Generics exist to *relate* input to output, not to accept anything. Constrain
every type parameter, let inference flow, and reach for conditional types to
express the relationship.

```ts
// relates element type in to element type out; honors noUncheckedIndexedAccess
function first<const T extends readonly unknown[]>(xs: T): T[number] | undefined {
  return xs[0];
}

type Unwrap<T> = T extends Promise<infer U> ? U : T;
```

Control inference explicitly: a `const` type parameter preserves literal/tuple
types through the call, and `NoInfer<T>` stops a parameter from being an
inference source — so a default or fallback can't widen `T`.

```ts
function withDefault<T>(value: T | undefined, fallback: NoInfer<T>): T {
  return value ?? fallback;
}
```

### 8. Ban the escape hatches

- `any` → `unknown`, then narrow with a *validated* type predicate / assertion fn.
- `as T` is a last resort; the only freely-allowed assertion is `as const`. No
  double casts — `as unknown as T` launders a lie through two casts; validate.
- No non-null `!` — narrow or prove via control flow.
- No `enum` — `as const` object + derived union.
- No weak types — `object`, `{}`, `Function`, `any[]` accept far too much (`{}`
  is anything non-nullish; `Function` is any callable with unchecked args). Use a
  precise signature, `Record<K, V>`, `unknown`, or `readonly unknown[]`.

```ts
// ❌ const run = (fn: Function) => fn();
// ✅
const run = <A extends readonly unknown[], R>(fn: (...a: A) => R, ...a: A): R => fn(...a);
```

### 9. Brand every primitive that carries an invariant

A primitive whose value range or provenance matters is not just a `string` or
`number`. Brand it so the compiler tracks where it came from and two same-shaped
primitives stop being interchangeable. The `as Brand` cast lives **only** inside
the smart constructor / validator — never at a call site.

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

type UserId = Brand<string, "UserId">;
type Email  = Brand<string, "Email">;
type Cents  = Brand<number, "Cents">;      // money in integer minor units
type Ratio  = Brand<number, "Ratio">;      // 0..1

// the single sanctioned `as`, localized to the constructor
function toEmail(raw: string): Email {
  if (!/^[^@\s]+@[^@\s]+$/.test(raw)) throw new Error(`bad email: ${raw}`);
  return raw as Email;
}
function transfer(from: UserId, to: UserId, amount: Cents): void {}
// transfer("a", "b", 100) ❌ raw string/number rejected — must go through a validator
```

Brand by default for: entity ids, money/units (cents, millis, bytes), validated
strings (`Email`, `Url`, `Uuid`, `NonEmptyString`), bounded numbers (`Ratio`,
`PositiveInt`), and opaque tokens. If you'd write a comment explaining what a
`string`/`number` "really" is, brand it instead.

Money is always integer minor units, never a float. For ids or counters that can
exceed `Number.MAX_SAFE_INTEGER`, brand a `bigint`
(`type SnowflakeId = Brand<bigint, "SnowflakeId">`). Name constructors uniformly
— `toEmail` / `makeEmail` — and keep the cast nowhere else.

### 10. Name the discriminant `kind` by default

Every discriminated union (rule 5) needs a shared, `readonly`, string-literal
tag. Keep the *name* consistent across the codebase so unions read and refactor
the same way everywhere:

- **`kind`** — the default for variant / shape / message / node unions.
- **`status`** (or `state`) — when the field genuinely *is* a lifecycle state
  (`loading | success | error`); name it for what it means.
- **`type`** — only where an external convention requires it (Redux actions,
  DOM-style event objects); match the ecosystem rather than fight it.

```ts
type Shape =
  | { readonly kind: "circle"; readonly r: number }
  | { readonly kind: "rect"; readonly w: number; readonly h: number };

type Result =
  | { readonly status: "loading" }
  | { readonly status: "success"; readonly data: User }
  | { readonly status: "error"; readonly error: Error };
```

The tag is always lowercase, a string literal (never `boolean`/`number`), and
`readonly`. Pair with exhaustive `switch` + `assertNever` (rule 6).

### 11. Single source of truth — derive, don't duplicate

Never hand-maintain a type and a value (or two types) that must agree. Write one
canonical definition and derive the rest with `typeof` / `keyof typeof` /
`z.infer` / `Extract` / `Exclude` / the utility types.

```ts
const CONFIG = { retries: 3, region: "eu" } as const;
type Config = typeof CONFIG;                 // value is the source
type Region = (typeof CONFIG)["region"];     // "eu"

type Status = "idle" | "loading" | "success" | "error";
type Settled = Exclude<Status, "idle" | "loading">; // derive sub-unions, never re-list
```

`Extract<Union, { kind: "x" }>` picks a single variant out of a discriminated
union. `Extract`/`Exclude` fail *silently* on a typo'd member — when the filter
is a literal list, constrain it to the source first so a stale name is a compile
error:

```ts
type Subset<S extends U, U> = S;                    // errors if S ⊄ U
type Pending = Subset<"idle" | "loading", Status>;  // typo -> compile error
```

### 12. Validate at the boundary, type the interior

Everything crossing a trust boundary (`JSON.parse`, `fetch`, `process.env`,
`postMessage`, file I/O) is `unknown`. Parse it once at the edge with a schema or
honest predicate; the interior then stays fully typed. Never `JSON.parse(x) as T`.

```ts
const User = z.object({ id: z.string(), age: z.number().int().nonnegative() });
type User = z.infer<typeof User>;            // single source of truth (rule 11)
const user = User.parse(await res.json());   // throws or returns a typed User
```

Schema-first, library-agnostic: Zod, Valibot, and ArkType all express the schema
once and derive the type from it — pick one per project and validate at every
edge.

### 13. Exhaustive `Record<Union, T>` for total lookups

When a lookup must cover every member of a union, type it
`Record<TheUnion, T>` (not `Partial`, not an index signature). Adding a union
member then fails to compile until the new entry exists — exhaustiveness for data.

```ts
const label = {
  loading: "Loading…",
  success: "Done",
  error: "Failed",
} as const satisfies Record<Result["status"], string>;
```

### 14. Narrow without casts — predicates & assertion functions

The two sanctioned roads from `unknown`/wide → narrow without a cast. Pick by
what should happen when the value *isn't* the type. Either way the body must
*actually prove* what it claims — a predicate that returns `true` unchecked, or
an `asserts` that doesn't throw, is a disguised `as`.

**Type predicate — `x is T`.** Returns a `boolean`; you branch on it. Narrows
only inside the branch you take. Use when "not a `T`" is a normal path.

```ts
function isString(x: unknown): x is string {
  return typeof x === "string";
}
if (isString(v)) v.toUpperCase(); // v is string only inside the branch
```

**Assertion function — `asserts x is T`.** Returns `void` and *throws* on
failure; if it returns, the narrowing holds for the **rest of the scope** — no
branch. Use as a guard clause when "not a `T`" should abort.

```ts
function assertIsUser(x: unknown): asserts x is User {
  if (!isUser(x)) throw new TypeError("expected User");
}
assertIsUser(payload);
payload; // User from here to end of scope
```

|              | predicate `x is T`              | assertion `asserts x is T`   |
| ------------ | ------------------------------- | ---------------------------- |
| returns      | `boolean`                       | `void`                       |
| on failure   | returns `false` (you handle it) | **throws**                   |
| narrows      | inside the chosen branch        | rest of the scope, no branch |
| use when     | both outcomes are valid         | failure should abort         |

The bare `asserts cond` form (no `is`) narrows truthiness without naming a type —
how `node:assert` is typed: `function assert(c: unknown): asserts c`. An
`asserts` function **must** carry an explicit return-type annotation (TS won't
infer it).

### 15. Immutability by default

`readonly` fields; `ReadonlyArray<T>` / `ReadonlyMap` / `ReadonlySet` for params
and returns you don't mutate; `as const` tuples from factories/hooks
(`return [state, setState] as const`). Return new values instead of mutating
arguments. Widen to mutable only where mutation is the point.

### 16. Index access is `T | undefined` — guard it

Treat `arr[i]` and `obj[key]` as possibly-missing (what `noUncheckedIndexedAccess`
enforces). Guard, use `.at()`, or destructure with a check before use — never
assume presence.

```ts
const head = xs[0];               // T | undefined
if (head === undefined) return;
head;                             // T
```

### 17. Use `never` to make illegal states unrepresentable

`never` is the bottom type — it says "this can't happen" and the compiler proves
it. Use it to forbid a field in one arm of a union (so the *shape* rules out the
bad combination), and in `default` branches via `assertNever` (rule 6).

```ts
type Toggle =
  | { readonly on: true;  readonly reason?: never }
  | { readonly on: false; readonly reason: string };
```

### 18. `const` bindings; never widen by accident

Prefer `const`; `let s = "a"` widens to `string`, `const s = "a"` stays `"a"`.
When a literal must survive a `let` or a return, reach for `as const`. Don't
annotate a binding wider than its initializer.

### 19. Prefer `type`; compose with utility types

Default to `type` — it expresses unions, tuples, mapped and conditional types
that `interface` can't, and one consistent construct beats switching by case.
Build new shapes from a canonical one with `Pick`/`Omit`/`Partial`/`ReturnType`/
`Awaited` rather than restating fields.

`interface` earns its place where you specifically need declaration merging,
`extends`-based class/OO contracts, or the compiler-caching edge on very large
object hierarchies — reach for it deliberately there, not by default.

### 20. `Result<T, E>` for expected failures; throw only for bugs

Failures that are part of the domain (validation, not-found, a declined payment)
are *values*, not exceptions — return a tagged result so the caller must handle
them and the type system tracks both paths. Reserve `throw` for genuinely
exceptional / programmer-error cases.

```ts
type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

Type the error channel as a **discriminated union of string-literal codes** (a
`kind`/`code` field per rule 10), not a bare `string` or `Error` — so callers can
exhaustively handle each failure and adding one is a compile error at every call
site.

```ts
type ParseError =
  | { readonly code: "empty" }
  | { readonly code: "too_long"; readonly max: number }
  | { readonly code: "bad_char"; readonly at: number };

function parseTag(raw: string): Result<Tag, ParseError> { /* … */ }
```

### 21. Model "absent" vs "present-but-undefined" distinctly

With `exactOptionalPropertyTypes` on (see Enforcement), `x?: T` (the key may be
*missing*) and `x: T | undefined` (the key is *present*, value may be `undefined`)
are different contracts. Pick deliberately; don't pass `{ x: undefined }` to
satisfy an optional field. Use `?:` for "omittable", `| undefined` for "required
slot, emptiable".

### 22. One generic + conditional return over overloads

When a function's return type is a *function* of its input type, express that
with a single generic + conditional return — not a stack of overloads, which
drift from the implementation and don't compose. Overloads are a last resort,
reserved for genuinely unrelated argument shapes no single signature can express.

```ts
// ✅ one honest signature
function unwrap<T>(x: T): T extends Promise<infer U> ? U : T { /* … */ }
```

### 23. Options object over positional booleans

`doThing(true, false)` is unreadable and easy to transpose. Past ~2 params, or
whenever a param is a bare boolean, take a single `readonly` options object —
ideally with literal-union fields instead of booleans.

```ts
// ❌ render(item, true, false)
// ✅
render(item, { variant: "compact", interactive: true } as const);
```

### 24. Labeled tuples for positional data

When a tuple's positions have meaning, label them — the labels show in
hover/errors and document call sites without a separate comment. Pair with
`as const` / `readonly` so the arity and element types stay fixed.

```ts
type Point = readonly [x: number, y: number];           // not [number, number]
type RangeArgs = readonly [start: number, end: number, step?: number];
type Pair<K, V> = readonly [key: K, value: V];
```

### 25. Type-only imports

`import type { Foo }` for anything used only as a type — explicit intent, no
accidental runtime import, and required for clean output under
`verbatimModuleSyntax`.

### 26. `??` and `?.` over `||` and manual guards

`||` mis-fires on the falsy-but-valid values `0`, `""`, `false`. Use `??` for
defaulting and `?.` for optional access — they trigger only on `null`/`undefined`.

### 27. Total functions — handle every input, return for every path

A function's type should be honest about totality: cover every member of an input
union (rule 6), return on every path (no implicit `undefined` from a missing
branch), and prefer returning a value over throwing for in-domain inputs (rule 20).

---

## Enforcement — compiler & lint flags

The rules above hold under *any* config, but on a project you own the compiler
should be the enforcer. `strict: true` is the baseline; these are the additional
flags that back specific rules and which `strict` does **not** enable on its own:

| Flag | Backs |
| --- | --- |
| `noUncheckedIndexedAccess` | rule 16 — `arr[i]`/`obj[k]` become `T \| undefined` |
| `exactOptionalPropertyTypes` | rule 21 — absent vs present-but-undefined |
| `noImplicitReturns` | rules 2 & 27 — every path returns |
| `noFallthroughCasesInSwitch` | rule 6 — exhaustive, no accidental fallthrough |
| `noPropertyAccessFromIndexSignature` | rule 5 — `obj["k"]` for index signatures |
| `noImplicitOverride` | safe subclassing — `override` keyword required |
| `verbatimModuleSyntax` | rule 25 — explicit type-only imports |

ESLint (typescript-eslint) to catch what types alone can't:
`@typescript-eslint/switch-exhaustiveness-check` (rule 6),
`no-explicit-any` + `no-non-null-assertion` + `no-unnecessary-condition`
(rule 8), `consistent-type-imports` (rule 25),
`no-floating-promises` / `await-thenable` (async correctness).

These belong on a project you own. On a repo you don't, the patterns carry the
strictness on their own — that is the whole point of writing them
config-independently.
