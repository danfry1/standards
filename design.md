# Module design standards

How to split a codebase into modules that can be checked one at a time. Nobody
reads every line of a large codebase, and nobody should have to. What can be
read is the **boundary** between modules: a small, typed contract that says
what goes in, what comes out, and every way it can fail. If each contract is
precise and each module is proven against its contract in isolation, the
composed system can be trusted without auditing the whole thing at once.

The posture: **the contract is the unit of review.** Design every module so its
public surface alone tells you what it does, its tests prove it does exactly
that, and nothing it depends on or affects is hidden from that surface.

This standard sits above the others. [TypeScript](typescript.md) makes the
contract precise, [Error handling](error-handling.md) makes its failures
explicit, and [Testing](testing.md) makes the proof honest. Examples are in
TypeScript; the rules apply in any language.

Legend: ✅ do · ❌ avoid.

---

## Core rules

### 1. Every module has one declared public surface

A module is a directory with a single entry point (`index.ts`, or the `exports`
map of a package). What that file exports is the contract; everything else is
private and may change freely. Callers import from the entry point, never from
a file inside the module.

```ts
// ✅ the contract, and nothing else
// billing/index.ts
export type { Invoice, InvoiceError } from "./types.ts";
export { createBilling } from "./billing.ts";

// ❌ reaching past the boundary couples you to the implementation
import { roundToCents } from "../billing/internal/money.ts";
```

If a caller needs something that is not exported, the contract is incomplete:
add it deliberately, or move the logic into the module.

### 2. Deep modules, not shallow ones

A module earns its place by hiding more than it exposes. A **deep** module has
a small interface over a lot of behavior; a **shallow** one has an interface
about as complex as its implementation, so callers pay to learn it and get
little back.

```ts
// ❌ shallow: the caller still does all the work, in the right order
const client = new HttpClient(baseUrl);
client.setHeader("Authorization", `Bearer ${token}`);
const res = await client.get(`/users/${id}`);
if (res.status === 404) { /* ... */ }
const user = UserSchema.parse(await res.json());

// ✅ deep: one call, every detail behind the boundary
const result = await users.get(id); // Result<User, UserError>
```

Signs a module is shallow: functions that only forward to another module,
getters and setters that expose internal state, an interface that mirrors the
implementation's steps, or callers that must call methods in a particular
order. Merge pass-through layers into whatever they wrap.

### 3. Handle the special cases inside the module

Pull complexity down, not up. Defaults, retries, normalization and edge cases
belong inside the module that understands them, so every caller gets them for
free instead of each one handling them, or forgetting to.

```ts
// ❌ every caller has to remember the empty-cart case
if (cart.items.length === 0) return zeroTotal;
const total = pricing.total(cart);

// ✅ the module defines the answer for every valid input
const total = pricing.total(cart); // an empty cart totals zero
```

A failure the caller can act on belongs in the contract (rule 4). A detail the
caller can't act on belongs inside the module.

### 4. The contract is the types: inputs, outputs and every failure

Someone reading only the signature should know what the module accepts, what
it returns, and every expected way it can fail. Use branded types for inputs
that carry an invariant ([TypeScript rule 9](typescript.md#9-brand-every-primitive-that-carries-an-invariant)),
and put expected failures in the return type as a discriminated union
([TypeScript rule 20](typescript.md#20-resultt-e-for-expected-failures-throw-only-for-bugs)).

```ts
// ❌ says nothing: what can `data` be? what does it throw?
export async function charge(data: any): Promise<any>;

// ✅ the whole contract is visible at the boundary
export type ChargeError =
  | { kind: "card-declined"; reason: DeclineReason }
  | { kind: "amount-too-small"; minimum: Cents }
  | { kind: "provider-unavailable"; retryAfter: Seconds };

export function charge(
  customer: CustomerId,
  amount: Cents,
): Promise<Result<ChargeId, ChargeError>>;
```

A thrown error is part of no signature, so reserve `throw` for bugs. Anything a
caller is expected to handle is a value in the return type.

### 5. Describe each export by its behavior, not its implementation

Give every export a short doc comment stating what it does, its preconditions,
and what each error variant means. Write it so it stays true if the
implementation is rewritten. Don't let implementation types leak into the
signature: no ORM rows, SDK response objects or framework types crossing the
boundary ([Error handling rule 9](error-handling.md#9-translate-errors-at-boundaries-dont-leak-foreign-error-types)
applies the same idea to errors).

```ts
// ❌ the contract is now "whatever Prisma and Stripe return"
export function getInvoice(id: string): Promise<Prisma.InvoiceGetPayload<{}>>;

// ✅ the module's own types; the storage choice stays private
/**
 * Returns the invoice with this id.
 * Fails with `not-found` if no invoice has this id, including one that was voided.
 */
export function getInvoice(id: InvoiceId): Promise<Result<Invoice, InvoiceError>>;
```

### 6. Validate at the boundary, trust the interior

Data entering a module from outside the type system (network, disk, user
input, another process) is parsed into the module's types at the boundary.
Past that point the interior trusts its types and does not re-check them
([TypeScript rule 12](typescript.md#12-validate-at-the-boundary-type-the-interior)).
Data passed between typed modules is already valid; it is the contract's job
to make that true.

### 7. Depend on contracts the consumer owns

When a module needs something from outside (storage, a clock, a payment
provider), it declares the narrowest interface it needs and takes an
implementation as a parameter. It never imports a concrete dependency directly.
This is what makes the module testable in isolation (rule 9), and it keeps the
dependency's contract as small as the consumer's actual needs.

```ts
// ❌ hard-wired: can't run without a real database and the real clock
import { db } from "../db/index.ts";
export function expireTrials() {
  return db.trials.expireBefore(new Date());
}

// ✅ the module states what it needs; anything that satisfies it plugs in
export type TrialStore = {
  expireBefore(cutoff: Instant): Promise<Result<number, StoreError>>;
};
export type Clock = { now(): Instant };

export function createTrials(deps: { store: TrialStore; clock: Clock }) {
  return {
    expire: () => deps.store.expireBefore(deps.clock.now()),
  };
}
```

Wire real implementations together in one place, the composition root (the
app's entry point), and nowhere else.

### 8. No hidden channels

Everything a module reads or affects goes through its contract. No shared
mutable module-level state, no singletons imported from elsewhere, no reading
`process.env` or the clock deep inside, no side effects on import. A hidden
channel is a dependency the contract doesn't show, so isolated tests can't see
it and a reviewer reading the boundary can't either.

```ts
// ❌ behavior depends on things the signature never mentions
let cache = new Map<string, Rate>();
export function convert(amount: Cents, to: Currency) {
  const rate = cache.get(to) ?? fetchRate(process.env.FX_API_URL!, to);
  // ...
}

// ✅ configuration and collaborators arrive through the contract
export function createConverter(deps: { rates: RateSource }) { /* ... */ }
```

Configuration is read once, at the composition root, validated (rule 6), and
passed in.

### 9. Test each module in isolation, through its public surface only

A module's tests import only its entry point and give it fakes for its
dependencies (rule 7). They exercise every behavior the contract promises and
every error variant in its return type. Every error variant needs at least one
test that produces it. A test that imports an internal file is testing the
implementation, and breaks when the implementation is improved
([Testing rule 9](testing.md#9-test-observable-behavior-not-implementation)).

```ts
// ✅ the contract, end to end, with in-memory fakes
import { createTrials } from "../trials/index.ts";

it("expires trials that started before the cutoff", async () => {
  const store = new InMemoryTrialStore([trialStartedAt("2026-01-01")]);
  const trials = createTrials({ store, clock: fixedClock("2026-02-01") });

  await expect(trials.expire()).resolves.toStrictEqual(ok(1));
});
```

Prefer a hand-written fake that behaves like the real thing over a mock that
records calls ([Testing rule 17](testing.md#17-prefer-real-implementations-and-fakes-over-mocks)).

### 10. Run one contract test suite against the real implementation and the fake

Isolated tests are only as good as the fakes they use. If the fake behaves
differently from the real implementation, every test built on it passes while
the real system fails. Write the dependency's contract once as a shared test
suite, and run it against both.

```ts
// trial-store.contract.ts: what any TrialStore must do
export function trialStoreContract(make: () => Promise<TrialStore>) {
  it("returns how many trials it expired", async () => { /* ... */ });
  it("does not expire a trial started exactly at the cutoff", async () => { /* ... */ });
}

// ✅ the same suite, both sides
describe("InMemoryTrialStore", () => trialStoreContract(async () => new InMemoryTrialStore()));
describe("PostgresTrialStore", () => trialStoreContract(() => postgresTrialStore(testDb)));
```

This is what lets modules proven in isolation be trusted together: each side of
every seam is checked against the same contract.

### 11. One thin wiring test per composition root

With every module proven against its contract and every fake proven against
the real thing, end-to-end tests only need to show the parts are connected:
the real implementations are passed in, the configuration is read, a request
gets from the entry point to storage and back. Keep this to a handful of tests
that cover the main paths. Don't re-test module behavior through the whole
stack; a failure there should point at wiring, not logic.

### 12. Dependencies point one way

Modules form a directed graph with no cycles. A cycle means two modules can't
be understood, tested or changed apart, so they are one module with a boundary
drawn through the middle. Break it by moving the shared piece into its own
module, or by having one side declare an interface the other implements
(rule 7).

### 13. Contract changes are visible in review

Changing what a module exports is a different kind of change from changing how
it works, and a reviewer should be able to see it without reading the diff of
every file. Generate the public surface as an artifact (declaration files from
`tsc --emitDeclarationOnly`, or an API report), commit it, and fail CI when it
is out of date. A pull request that touches a contract then shows exactly which
signatures changed.

```bash
# ✅ regenerate the contracts; CI fails if the committed copy differs
tsc -p tsconfig.api.json --emitDeclarationOnly --outDir api/
git diff --exit-code api/
```

When a contract changes, update its contract tests (rule 10) and every module
that depends on it in the same change.

---

## Enforcement

Most of these rules are about judgment, so the main check is review. What can
be automated:

- **Rule 1, rule 12:** forbid deep imports and cycles with ESLint
  (`no-restricted-imports` patterns for `*/internal/*` and sibling module
  files; `import/no-cycle`), or with the `exports` map of each package in a
  workspace.
- **Rule 4:** the [TypeScript](typescript.md#enforcement-typescript-compiler-and-lint-flags)
  flags ban `any` and unchecked casts at every boundary.
- **Rule 8:** `no-restricted-properties` on `process.env` everywhere except the
  composition root.
- **Rule 13:** the committed declaration files, checked by `git diff
  --exit-code` in CI.

When reviewing a change, read in this order:

- [ ] Did any contract change? Read the diff of the generated declarations first.
- [ ] Can a caller tell what each changed export does, and every way it fails, from the signature and doc comment alone?
- [ ] Does each module's test suite import only its entry point, and cover every error variant?
- [ ] Does each fake run the same contract suite as the real implementation?
- [ ] Is anything new read or written that the contract doesn't show?
