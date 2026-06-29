# Error-handling standards (JS/TS)

How to handle failure so that **no error is ever opaque**. Two invariants run
through every rule:

1. **A caught error is never left as `unknown`.** Every value that reaches a
   `catch` is narrowed to a known type before anything reads it — no
   `(e as Error).message`, no blind `e.code`.
2. **A thrown error is never a bare `Error`.** Everything thrown is a custom
   error carrying the structured context needed to *catch it precisely* and
   *understand why it happened* — a discriminant, the inputs that triggered it,
   and the original `cause`.

The two ends meet: throws are typed and contextful so catches can narrow them
exhaustively. This standard is about *exceptional* failure (bugs, broken
invariants, infrastructure faults). Expected, in-domain failures should be
*values* — see [`Result<T, E>`](typescript.md) (TypeScript rule 20) — and most
of what follows applies to the `error` channel of a `Result` just the same.

Legend: ✅ preferred · ❌ avoid.

---

## Core rules

### 1. Never throw a bare `Error` — throw a typed, contextful custom error

`throw new Error("failed")` produces a value a catcher can only re-inspect by
substring-matching the message. Define an error *class* per failure mode, give it
a stable discriminant, and attach the data that explains the failure.

```ts
// ❌ untyped, contextless — the catcher learns nothing it can branch on
throw new Error(`payment failed for ${userId}`);

// ✅ a typed error carrying everything needed to catch and diagnose it
throw new PaymentDeclinedError({
  userId,
  amountCents,
  declineCode: "insufficient_funds",
  cause: gatewayError,
});
```

A throw is an API. Its type is part of that API; its message is for humans, not
for control flow.

### 2. Give every error a stable, literal discriminant

Branch on a `readonly code` (or `kind`/`name`) literal, never on the message or
on `instanceof` chains alone. A literal discriminant lets a catch narrow
exhaustively and makes adding a new failure mode a compile error at every
handler (per the discriminated-union model in [TypeScript](typescript.md) rules
6 and 20).

```ts
type AppErrorCode =
  | "validation"
  | "not_found"
  | "unauthorized"
  | "payment_declined"
  | "upstream_unavailable";

abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
}
```

Renaming a message must never break a handler; changing a `code` should.

### 3. Errors carry structured context as fields, not interpolated strings

The data that explains *why* belongs in typed fields the catcher can read — not
baked into the message where only a regex can recover it. Put the human summary
in `message` *and* the machine-readable facts in fields.

```ts
// ❌ the only way to recover `field`/`max` is to parse the string
throw new Error(`field "title" exceeds 80 chars`);

// ✅ readable message + structured, queryable context
class ValidationError extends AppError {
  readonly code = "validation" as const;
  constructor(
    readonly field: string,
    readonly reason: "required" | "too_long" | "bad_format",
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(`validation failed on "${field}": ${reason}`);
  }
}
```

### 4. Always preserve the original `cause`

When you wrap or translate an error, pass the original through the standard
`cause` option (ES2022). Dropping it discards the stack and the root reason —
the exact thing rule 1 exists to keep.

```ts
// ❌ original error and its stack are gone
catch (e) {
  throw new UpstreamError("inventory lookup failed");
}

// ✅ the chain is preserved end to end
catch (e) {
  throw new UpstreamError("inventory lookup failed", {
    cause: toError(e),          // rule 6
    service: "inventory",
    sku,
  });
}
```

Custom error constructors must accept and forward `{ cause }` to
`super(message, { cause })`.

### 5. A caught value is `unknown` — narrow it before reading anything

`catch (e)` binds `e` as `unknown` (enable `useUnknownInCatchVariables`, on under
`strict`). JavaScript lets code `throw` *any* value — a string, `undefined`, a
plain object — so the type is honest: you don't yet know what you have. Narrow
before you touch it; never assert.

```ts
// ❌ blind cast — explodes if something threw a string or null
catch (e) {
  log((e as Error).message);
}

// ✅ narrow with a guard, then handle each known shape
catch (e) {
  if (isAppError(e)) return handleAppError(e);   // rule 6
  throw e;                                        // rule 8 — not ours to swallow
}
```

This is the runtime companion to rule 1: typed throws are only useful if catches
refuse to treat them as `unknown`.

### 6. Narrow with type guards and a normalizer — never `as`

Provide a guard per error family and a single normalizer that turns *any* thrown
value into a known `Error`. Every `catch` goes through one of them.

```ts
function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

// any thrown value -> a real Error, with the original kept as `cause`
function toError(e: unknown): Error {
  if (e instanceof Error) return e;
  return new Error(`non-Error thrown: ${typeof e}`, { cause: e });
}
```

With these, no handler ever sees `unknown` past its first line, and no `catch`
needs an `as` (TypeScript rules on the two sanctioned roads from `unknown`).

### 7. Catch only what you can handle here; let everything else propagate

A `catch` that isn't narrowed catches *everything* — including the
`TypeError` from a bug three frames down — and turns a loud failure into silent
wrong behavior. Catch the specific code you can act on; re-throw the rest
unchanged so it surfaces where someone can.

```ts
// ❌ swallows unrelated bugs as if they were the not-found case
try { return await load(id); }
catch { return null; }

// ✅ handle the one case you understand; propagate the rest with its context
try { return await load(id); }
catch (e) {
  if (isAppError(e) && e.code === "not_found") return null;
  throw e;
}
```

### 8. Never swallow — no empty `catch`, no log-and-continue

An empty `catch {}`, or one that only logs and falls through, converts a failure
into corrupt state that surfaces far away. Every catch must do exactly one:
**handle** (and recover), **translate** (rule 9), or **re-throw**. "Log and
continue" is none of those.

```ts
// ❌ the operation failed but the program proceeds as if it succeeded
try { await persist(order); } catch (e) { console.error(e); }

// ✅ translate to a domain error and stop the broken path
try { await persist(order); }
catch (e) { throw new PersistError({ entity: "order", id: order.id, cause: toError(e) }); }
```

### 9. Translate errors at boundaries; don't leak foreign error types

Where an external dependency's errors enter your code (DB driver, HTTP client,
parser), convert them once into your own error union. Inside the domain, every
error is an `AppError`; raw `PrismaClientKnownRequestError` / `FetchError` /
`ZodError` never travel past the adapter that produced them.

```ts
async function getUser(id: UserId): Promise<User> {
  try {
    return await db.user.findUniqueOrThrow({ where: { id } });
  } catch (e) {
    if (isPrismaNotFound(e)) throw new NotFoundError({ entity: "user", id, cause: e });
    throw new UpstreamError("db.getUser failed", { cause: toError(e), id });
  }
}
```

This is what keeps rule 5's narrowing finite: callers handle *your* codes, not
the open-ended error zoo of every transitive dependency.

### 10. Prefer `Result<T, E>` for expected failures; reserve `throw` for the exceptional

If a failure is a normal outcome the caller must reckon with — validation,
not-found, a declined card — return it as a value so the type system forces
handling and there's no hidden control flow. Throw for broken invariants,
programmer error, and faults no local caller can sensibly handle. (Full model:
[TypeScript](typescript.md) rule 20.)

```ts
// expected outcome -> value the caller must destructure
function parseAmount(raw: string): Result<Cents, ValidationError> { /* … */ }

// genuinely exceptional -> throw a typed error
function assertInvariant(cond: boolean, ctx: InvariantContext): asserts cond {
  if (!cond) throw new InvariantError(ctx);
}
```

Don't throw to signal an ordinary branch, and don't return a `Result` for a
state that means the program is already broken.

### 11. Make errors serializable and safe to log

An error is only as useful as what survives into the logs. `Error` fields don't
JSON-stringify by default and `cause` chains are easy to lose. Give the base
class a `toJSON` that emits the discriminant, the context fields, and a flattened
cause — and keep secrets out of it.

```ts
abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...this.context,                       // typed, non-sensitive fields
      cause: this.cause instanceof Error
        ? { name: this.cause.name, message: this.cause.message }
        : this.cause,
    };
  }
}
```

Never put tokens, passwords, or full PII in error context; log an identifier, not
the secret.

### 12. Set up custom error classes correctly (prototype, name, stack)

Subclassing the built-in `Error` has two well-known traps: under transpilation to
ES5 the prototype chain breaks (so `instanceof` — rule 6 — silently fails), and
`name` defaults to `"Error"`. Fix both in the base class once.

```ts
abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;                 // real subclass name in stacks
    Object.setPrototypeOf(this, new.target.prototype); // instanceof works post-transpile
  }
}
```

### 13. No floating rejections — type and await every async failure path

An async function that can fail is the async form of a throw; the same typing and
the same "don't swallow" rules apply. An un-awaited promise rejects into the void
and is lost. `await` (or explicitly handle) every promise, and enable
`@typescript-eslint/no-floating-promises`.

```ts
// ❌ rejection escapes the try; the catch never sees it
try { void persist(order); } catch (e) { /* never runs */ }

// ✅ awaited — failure is caught and translated (rule 9)
try { await persist(order); }
catch (e) { throw new PersistError({ id: order.id, cause: toError(e) }); }
```

### 14. One handler at the top translates errors to responses/exit codes

Domain code throws typed errors; it does not format HTTP responses or call
`process.exit`. A single boundary handler (Express error middleware, a route
wrapper, the CLI's top frame) switches on `code` to map each error to a status /
exit code / user message — exhaustively, so a new code forces a new branch.

```ts
function toHttp(e: AppError): { status: number; body: ErrorBody } {
  switch (e.code) {
    case "validation":         return { status: 400, body: render(e) };
    case "unauthorized":       return { status: 401, body: render(e) };
    case "not_found":          return { status: 404, body: render(e) };
    case "payment_declined":   return { status: 402, body: render(e) };
    case "upstream_unavailable": return { status: 502, body: render(e) };
    default: { const _exhaustive: never = e.code; throw e; }   // new code -> compile error
  }
}
```

This keeps formatting in one place and guarantees (rule 2) that every failure
mode has a deliberate outward representation.

---

## Enforcement — compiler & lint flags

The rules hold under any config, but on a project you own these mechanically
back them:

| Flag | Backs |
| --- | --- |
| `strict` / `useUnknownInCatchVariables` | Rule 5 — `catch` binds `unknown`, forcing narrowing. |
| `@typescript-eslint/no-floating-promises` | Rule 13 — every promise awaited/handled. |
| `@typescript-eslint/no-explicit-any` + `no-unsafe-*` | Rules 5–6 — no `as`/`any` escape hatch around caught values. |
| `@typescript-eslint/only-throw-error` | Rule 1 — only `Error` subclasses may be thrown. |
| `@typescript-eslint/use-unknown-in-catch-callback-variable` | Rule 5 — same narrowing for `.catch(cb)`. |
| `@typescript-eslint/switch-exhaustiveness-check` | Rules 2 & 14 — every error `code` handled. |
