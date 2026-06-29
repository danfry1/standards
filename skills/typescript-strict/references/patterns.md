# TypeScript Strict Patterns — Deep Catalog

The exhaustive reference behind the rules in `SKILL.md`. Read the relevant
section when a rule needs more than the one-liner. Every example assumes the
flags in `tsconfig.strict.json` are on.

## Table of contents

1. [`satisfies` and `as const satisfies` in depth](#1-satisfies-and-as-const-satisfies-in-depth)
2. [Template-literal type techniques](#2-template-literal-type-techniques)
3. [Discriminated unions & exhaustiveness](#3-discriminated-unions--exhaustiveness)
4. [Branding / nominal types & smart constructors](#4-branding--nominal-types--smart-constructors)
5. [Generics & inference control](#5-generics--inference-control)
6. [Narrowing: type predicates & assertion functions](#6-narrowing-type-predicates--assertion-functions)
7. [Mapped & conditional types](#7-mapped--conditional-types)
8. [`unknown` boundaries & validation](#8-unknown-boundaries--validation)
9. [`type` vs `interface`, and utility-type discipline](#9-type-vs-interface-and-utility-type-discipline)
10. [Type-level testing](#10-type-level-testing)
11. [Common strictness leaks & fixes](#11-common-strictness-leaks--fixes)

---

## 1. `satisfies` and `as const satisfies` in depth

`satisfies` checks a value against a type **without changing the value's
inferred type**. Annotation (`: T`) does the opposite — it replaces the
inferred type with `T`, widening literals and erasing excess precision.

```ts
// Annotation widens — `palette.brand` is `string`, indexing is unchecked.
const a: Record<string, string> = { brand: "#5B21B6" };

// satisfies validates but keeps `{ brand: "#5B21B6" }`.
const b = { brand: "#5B21B6" } satisfies Record<string, string>;

// as const + satisfies: deepest precision + a constraint guard.
const palette = {
  brand: "#5B21B6",
  danger: "#DC2626",
} as const satisfies Record<string, `#${string}`>;
//   palette.brand: "#5B21B6"   keyof typeof palette: "brand" | "danger"
```

When to use which:

| Goal | Use |
| --- | --- |
| Keep literals, check a constraint | `as const satisfies C` |
| Check a constraint, allow mutation | `satisfies C` |
| Force a public type at an API boundary | annotation `: T` (deliberately widen) |

Why `as const satisfies` beats annotation for config:

- `keyof typeof obj` gives the real key union, enabling exhaustive lookups.
- Indexed access returns the literal value type, not the widened constraint.
- Excess/typo'd keys and wrong value shapes still error against the constraint.

Partial constraints: constrain values while letting keys stay open.

```ts
const featureFlags = {
  newCheckout: { enabled: true, rollout: 0.5 },
  betaSearch: { enabled: false, rollout: 0 },
} as const satisfies Record<string, { enabled: boolean; rollout: number }>;
```

## 2. Template-literal type techniques

Build, don't enumerate. Combine unions to get the cross product:

```ts
type Size = "sm" | "md" | "lg";
type Variant = "solid" | "outline";
type ButtonClass = `btn-${Variant}-${Size}`; // 6 members, auto-maintained
```

Inference with `infer` to parse structure out of strings:

```ts
type Split<S extends string, D extends string> =
  S extends `${infer Head}${D}${infer Tail}` ? [Head, ...Split<Tail, D>] : [S];
type Parts = Split<"a/b/c", "/">; // ["a", "b", "c"]

// Typed route params:
type PathParams<S extends string> =
  S extends `${string}:${infer P}/${infer Rest}` ? P | PathParams<`/${Rest}`>
  : S extends `${string}:${infer P}` ? P
  : never;
type P = PathParams<"/users/:userId/posts/:postId">; // "userId" | "postId"
```

Intrinsic string types: `Uppercase`, `Lowercase`, `Capitalize`,
`Uncapitalize` — use them in key remapping (see §7) to derive `onClick` from
`click`, `GET` from `get`, etc.

Guardrail: deeply recursive template types can hit the instantiation-depth
limit. Keep recursion shallow or bounded; for large/dynamic strings, validate
at runtime and brand the result instead.

## 3. Discriminated unions & exhaustiveness

A discriminant is a `readonly` literal field shared by every member with a
unique value per member. Keep it a string literal for readable errors.

```ts
type Shape =
  | { readonly kind: "circle"; readonly r: number }
  | { readonly kind: "rect"; readonly w: number; readonly h: number };

function area(s: Shape): number {
  switch (s.kind) {
    case "circle": return Math.PI * s.r ** 2;
    case "rect":   return s.w * s.h;
    default:       return assertNever(s);
  }
}
function assertNever(x: never): never {
  throw new Error(`Unhandled: ${JSON.stringify(x)}`);
}
```

`assertNever` turns "forgot a case" into a compile error: adding a `"triangle"`
variant makes `s` non-`never` at `default`, so the call fails to type-check.
The ESLint rule `switch-exhaustiveness-check` enforces this without the manual
default, but keep `assertNever` for the runtime guarantee too.

Tagged results instead of throwing (Result/Either):

```ts
type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
```

## 4. Branding / nominal types & smart constructors

TypeScript is structural; branding simulates nominal typing so two
same-shaped primitives stop being interchangeable. Prefer a `unique symbol`
brand (unforgeable, non-enumerable) over a string-keyed `__brand`.

```ts
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

type Email = Brand<string, "Email">;
type PositiveInt = Brand<number, "PositiveInt">;

// Smart constructor: the ONLY way to obtain a branded value is through validation.
function toEmail(raw: string): Email {
  if (!/^[^@\s]+@[^@\s]+$/.test(raw)) throw new Error(`Invalid email: ${raw}`);
  return raw as Email; // the single sanctioned `as`, localized to the constructor
}
```

Rules:

- Brands live behind constructors/validators; the `as Brand` cast appears
  *only* inside the constructor, never at call sites.
- Brand anything with invariants a raw primitive can't express: IDs, money
  (store integer minor units), timestamps, validated strings, ratios in [0,1].
- Multiple brands compose: `Brand<Brand<number, "Int">, "Positive">`.

## 5. Generics & inference control

Constrain every parameter; an unconstrained `<T>` accepting anything is `any`
wearing a costume. Let inference flow from values — annotate type arguments
only when inference can't reach them.

```ts
// const type parameter: preserve literals through the call.
function tuple<const T extends readonly unknown[]>(...xs: T): T { return xs; }
const t = tuple("a", 1, true); // readonly ["a", 1, true], not (string|number|boolean)[]

// Relate key to value type with a constraint:
function prop<T, K extends keyof T>(obj: T, key: K): T[K] { return obj[key]; }

// NoInfer: stop a param from being an inference source.
function clamp<T extends number>(v: T, min: NoInfer<T>, max: NoInfer<T>): T { /* … */ return v; }

// Prefer one generic + conditional return over overloads when there's a relation:
type Unwrap<T> = T extends Promise<infer U> ? U : T;
async function settle<T>(x: T): Promise<Unwrap<T>> { return await (x as Awaited<T>); }
```

Variance: mark positions `readonly`/`out`-only where possible; default to
accepting `readonly T[]` and returning concrete types. Avoid generic
parameters that appear only in the return position with no argument to infer
from — that forces callers to annotate and usually signals a design smell.

Distributive conditional types: `T extends U ? X : Y` distributes over unions
when `T` is a naked type parameter. Wrap in tuples to opt out:
`[T] extends [U] ? …`.

## 6. Narrowing: type predicates & assertion functions

Two sanctioned ways from `unknown`/wide → narrow without `as`:

```ts
// Type predicate — returns boolean, narrows in the truthy branch.
function isNonEmpty<T>(a: readonly T[]): a is readonly [T, ...T[]] { return a.length > 0; }

// Assertion function — throws on failure, narrows for the rest of the scope.
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}
function assertIsString(x: unknown): asserts x is string {
  if (typeof x !== "string") throw new TypeError("expected string");
}
```

Make predicates *honest*: a predicate that returns `true` without actually
proving the shape is a silent `as`. Validate every field you claim.

`satisfies` + control-flow narrowing usually beats a cast. Reach for `in`,
`typeof`, `instanceof`, and discriminant checks before any assertion.

## 7. Mapped & conditional types

Key remapping with `as` builds derived shapes:

```ts
type Getters<T> = { [K in keyof T & string as `get${Capitalize<K>}`]: () => T[K] };
type EventMap<T extends string> = { [E in T as `on${Capitalize<E>}`]: () => void };

// Filter keys by value type:
type StringKeys<T> = { [K in keyof T]: T[K] extends string ? K : never }[keyof T];
```

Modifiers: add/remove `readonly` and `?` with `+`/`-`:

```ts
type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type Required2<T> = { [K in keyof T]-?: T[K] };
```

`exactOptionalPropertyTypes` note: with it on, `{ x?: number }` does **not**
accept `{ x: undefined }`. Model "explicitly absent" as `x?: number` and
"present but empty" as `x: number | undefined` — they are now distinct.

## 8. `unknown` boundaries & validation

Every value crossing a trust boundary (network, `JSON.parse`, `process.env`,
file I/O, `postMessage`) is `unknown`. Parse it into a known type once, at the
edge; the interior stays fully typed.

```ts
// process.env is Record<string, string | undefined> under strict — never assume presence.
const port = process.env["PORT"]; // string | undefined (noPropertyAccessFromIndexSignature)
```

Schema-first is the scalable form: define a schema, derive the type, validate
at the edge.

```ts
import { z } from "zod";
const User = z.object({ id: z.string(), age: z.number().int().nonnegative() });
type User = z.infer<typeof User>;          // single source of truth
const user = User.parse(await res.json()); // throws or returns typed User
```

Do not hand-write a type *and* a parser that can drift. Derive one from the
other.

## 9. `type` vs `interface`, and utility-type discipline

- Default to `type`. It expresses unions, tuples, mapped/conditional types,
  and template literals; `interface` cannot. One consistent construct beats
  switching by case. (`interface` is acceptable when you specifically need
  declaration merging or are authoring extensible public OO APIs.)
- Compose with the built-in utility types — `Pick`, `Omit`, `Partial`,
  `Required`, `Readonly`, `Record`, `Extract`, `Exclude`, `NonNullable`,
  `ReturnType`, `Parameters`, `Awaited`, `InstanceType` — rather than restating
  shapes. Derive types from a single canonical definition; never maintain two
  shapes that must agree by hand.
- Prefer `Readonly<T>` / `readonly` modifiers in public surfaces.

```ts
type User = { readonly id: string; name: string; email: string };
type PublicUser = Omit<User, "email">;
type UserPatch = Partial<Pick<User, "name" | "email">>;
```

## 10. Type-level testing

Treat types as code that deserves tests. Assert relationships so refactors
can't silently change a public type.

```ts
type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type _1 = Expect<Equal<PathParams<"/u/:id">, "id">>;
type _2 = Expect<Equal<keyof typeof palette, "brand" | "danger">>;
```

Or use `expect-type` / `tsd` / Vitest's `expectTypeOf` in the test suite.
Pair with `tsc --noEmit` in CI so type regressions fail the build.

## 11. Common strictness leaks & fixes

| Leak | Fix |
| --- | --- |
| `arr[i]` assumed defined | `noUncheckedIndexedAccess` makes it `T \| undefined`; guard or use `.at()` then check |
| `obj[key]` on index signature | `noPropertyAccessFromIndexSignature` forces `obj["key"]`; or model exact keys |
| `{ x: undefined }` to satisfy `x?` | `exactOptionalPropertyTypes` distinguishes them — pick the right one |
| `catch (e)` treated as `Error` | `e` is `unknown`; narrow with `instanceof Error` before use |
| Overriding a base method silently | `noImplicitOverride` requires the `override` keyword |
| `as` to fix a type error | almost always means the model is wrong — fix the type, don't cast |
| `JSON.parse(...)` typed as `T` | it returns `any`; treat as `unknown` and validate (§8) |
| `Function`, `object`, `{}` types | use precise signatures / `Record` / `unknown` — these accept too much |
| Enum imported across modules | `const enum` breaks `isolatedModules`; use `as const` object (SKILL.md §6) |
| Default export | prefer named exports — better refactors, `verbatimModuleSyntax` friendliness |
