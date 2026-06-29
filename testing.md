# Testing standards (JS/TS — Vitest & Jest)

How to write tests that catch real regressions instead of handing out **fake
safety** — green checks that prove nothing. A bad test is worse than no test: it
costs maintenance *and* lies about coverage. Every rule below keeps a test honest,
which means two things — it **pins the actual behavior** precisely, and it **can
actually fail** when that behavior breaks.

Examples use Vitest's `vi`; Jest is identical with `jest` in place of `vi` (the
matchers are the same). Scope: unit and integration tests of logic. DOM /
component testing (Testing Library) follows the same philosophy but has its own
query and interaction rules — a separate standard.

Legend: ✅ preferred · ❌ avoid (fake safety).

---

## Core rules

### 1. Assert exact values, never truthiness

`toBeTruthy`/`toBeFalsy` pass for a huge range of values — `1`, `"0"`, `[]`, `{}`
are all truthy — so they hide bugs where the function returns *something*, just
not the right thing. Assert the exact value.

```ts
// ❌ passes for "ok", [], {}, any non-zero number… proves almost nothing
expect(isValid(input)).toBeTruthy();

// ✅ pins the real result
expect(isValid(input)).toBe(true);
expect(user.role).toBe("admin");
```

Same for `toBeDefined()` (passes for `null`, `0`, `false`) — assert what it *is*.

### 2. `toStrictEqual` over `toEqual`

`toEqual` is lenient in ways that hide bugs: it treats `{ a: undefined }` as
equal to `{}`, ignores sparse-array holes, and does **not** check that two values
share a type/class. `toStrictEqual` checks all three. Default to it for deep
equality.

```ts
// ❌ toEqual: these all pass and shouldn't
expect({ a: 1, b: undefined }).toEqual({ a: 1 });        // missing key ignored
expect([1, , 3]).toEqual([1, undefined, 3]);             // hole vs undefined
expect(new Point(1, 2)).toEqual({ x: 1, y: 2 });         // class vs plain object

// ✅ toStrictEqual catches every one of those
expect(result).toStrictEqual({ a: 1, b: undefined });
```

Use `toBe` for primitives and reference identity (it's `Object.is`); reserve
`toStrictEqual` for structural deep equality. Beware the looser cousins —
`toMatchObject` and `expect.objectContaining` match *partially* and ignore
unasserted keys: fine when "contains at least" is genuinely the intent, a
fake-safety trap when you meant "equals". Reach for them deliberately, never as
the default.

### 3. Assert exact call arguments, not just "it was called"

`toHaveBeenCalled()` proves a function ran, not that it ran *correctly*. Assert
the arguments and the call count.

```ts
// ❌
expect(save).toHaveBeenCalled();

// ✅ exact args + how many times
expect(save).toHaveBeenCalledTimes(1);
expect(save).toHaveBeenCalledWith({ id: "u1", status: "active" });
```

Reach for `expect.objectContaining`/`expect.any` only when a field is genuinely
nondeterministic (a timestamp, a generated id) — and then assert its *shape*, not
skip it.

### 4. Assert the specific error — never a bare `toThrow()`

`toThrow()` with no argument passes for *any* thrown value, including the
`TypeError` from a typo in the test itself. Pin the error type and a stable part
of the message or shape.

```ts
// ❌ passes if it throws for the wrong reason
expect(() => parse(bad)).toThrow();

// ✅ the error you actually expect
expect(() => parse(bad)).toThrow(ValidationError);
expect(() => parse(bad)).toThrow(/missing field: email/);
await expect(fetchUser(id)).rejects.toThrow(NotFoundError);
```

### 5. Every test must be able to fail

A test with no reachable assertion is green theater. For async/callback code,
guard that the assertions actually ran with `expect.assertions(n)` —
otherwise a promise that rejects early can skip every `expect` and still pass.

```ts
// ✅ proves the catch block was actually reached
it("rejects an expired token", async () => {
  expect.assertions(1);
  try {
    await authorize(expiredToken);
  } catch (e) {
    expect(e).toBeInstanceOf(TokenExpiredError);
  }
});
```

(Better still, prefer `await expect(authorize(t)).rejects.toThrow(...)` — rule 4
— which can't silently skip.)

### 6. Await every async assertion — no floating promises

`expect(p).resolves`/`rejects` returns a promise; un-awaited, the assertion
resolves *after* the test passes and its failure is lost. Always `await` (or
`return`) it.

```ts
// ❌ assertion floats; test is green even when it should fail
expect(loadConfig()).resolves.toStrictEqual(defaults);

// ✅
await expect(loadConfig()).resolves.toStrictEqual(defaults);
```

Enable `@typescript-eslint/no-floating-promises` so the compiler catches these.

### 7. No control flow around assertions

`if`/`for`/`try` in a test body is how assertions get silently skipped — a loop
over an empty array asserts nothing; a misplaced branch never runs its `expect`.
Parametrize with `it.each` and keep one straight-line path.

```ts
// ❌ if `cases` is empty, this test passes having asserted nothing
for (const c of cases) {
  if (c.valid) expect(validate(c.input)).toBe(true);
}

// ✅ each case is its own visible, countable test
it.each([
  { input: "a@b.co", expected: true },
  { input: "nope",   expected: false },
])("validate($input) -> $expected", ({ input, expected }) => {
  expect(validate(input)).toBe(expected);
});
```

Keep table rows literal — generated or computed cases reintroduce the tautology
of rule 8.

### 8. Hardcode expected values — don't recompute them

If the test computes its expectation with the same logic it's testing, it's a
tautology that passes even when both are wrong. Write the literal expected value.

```ts
// ❌ tautology — reuses the function under test (or its formula)
expect(slug(title)).toBe(title.toLowerCase().replace(/\s+/g, "-"));

// ✅ a human-verified literal
expect(slug("Hello World")).toBe("hello-world");
```

### 9. Test observable behavior, not implementation

Assert what a caller can observe — return value, thrown error, a message put on a
queue, a row written. Don't assert that a private helper was called or that
internal state took a value; those pass while the behavior is broken and break
while the behavior is fine. The more a test mocks, the less it tests.

```ts
// ❌ couples the test to how it's done; survives a total rewrite of behavior
expect(service["recalculateInternals"]).toHaveBeenCalled();

// ✅ asserts the outcome a user cares about
expect(await service.totalFor(cart)).toStrictEqual({ cents: 1299 });
```

### 10. Don't test your mocks

Asserting that a stub returns the value you told it to return tests nothing but
the mocking library. Mock only at real boundaries you don't own (network, clock,
filesystem); let the code under test run for real. If a test would still pass
with the implementation gutted, it's testing the mock.

### 11. Make tests deterministic

Flaky tests train people to re-run until green — the ultimate fake safety. Remove
every source of nondeterminism: freeze the clock, fake timers, seed randomness,
and never touch the real network or wall clock.

```ts
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
});
afterEach(() => vi.useRealTimers());
```

Inject randomness/time as dependencies, or stub `Math.random`/`Date.now`. No
`setTimeout`-based sleeps to "wait" for things — advance fake timers or await a
real signal.

### 12. Isolate tests — reset state between them

Order-dependent tests give safety that evaporates when the file is re-sharded.
No shared mutable module state; restore mocks and clear singletons between tests.

```ts
// vitest.config: { test: { restoreMocks: true, clearMocks: true } }
afterEach(() => vi.restoreAllMocks());
```

Each test must pass when run alone and in any order (`--sequence.shuffle`).

### 13. Snapshots are a last resort

A large snapshot is reviewed once, then updated with `-u` forever — it asserts
"nothing changed", not "this is correct," and bloats diffs. Prefer explicit
assertions. When a snapshot genuinely earns its place (small, stable serialized
output), keep it *inline* and small so the expectation is reviewable in the test.

```ts
// ✅ small, local, reviewable
expect(formatTree(node)).toMatchInlineSnapshot(`"a > b > c"`);
```

Never snapshot a whole component tree / large object as a substitute for
asserting the few things that matter.

### 14. Coverage is a tool, not a goal

100% line coverage with weak assertions is the purest fake safety — every line
ran, nothing was checked. Coverage shows what was *executed*, never what was
*verified*. Aim assertions at behavior and edge cases; for a real measure of test
strength, mutation testing (does a test fail when the code is broken?) beats a
coverage number.

### 15. Name tests by behavior and condition

`it("works")` / `test("user")` tell you nothing when they fail. Name the expected
behavior and the condition that triggers it.

```ts
// ❌ it("user")
// ✅
it("returns 401 when the token is expired", () => { /* … */ });
```

### 16. One behavior per test; arrange–act–assert

A test that acts several times and asserts throughout hides which step failed.
One logical act, a focused set of assertions, clear AAA sections. If a test needs
"and" in its name, it's probably two tests.

### 17. Prefer real implementations and fakes over mocks

Mocks assert *interactions*; fakes (an in-memory repository, a test double that
actually behaves) assert *behavior*. Reach for a fake before a mock, and for the
real thing before a fake when it's cheap and deterministic — each step up
couples the test less to implementation detail (rule 9).

### 18. Test the unhappy path and the edges

Happy-path-only suites give confidence exactly where bugs aren't. Cover empty,
`null`/`undefined`, boundary values, duplicates, and the documented error cases —
that's where regressions actually live.

### 19. Don't test the framework or the language

No tests for "does `Array.map` work", a library's own behavior, or trivial
pass-through getters. Test *your* logic; trust dependencies, or test them once at
their boundary.
