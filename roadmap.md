# Roadmap: the agent workflow standard

Where the [agent workflow standard](agents.md) goes next, and in what order.
The aim is a standard others can adopt and check themselves against, not just
read. That takes three things most published advice lacks: rules precise enough
to test, a working implementation, and evidence from real use.

Each stage has an exit criterion. A stage isn't done until its criterion is met.

## 1. Trial on a real project

Run the standard on `vitest-native` (in fleet mode, six lanes, one
maintainer) and measure it against a baseline taken before the trial.

Baseline, 2026-11-14: 400 pull requests merged in the previous six weeks; a
median of 1.1 hours from opening to merge, 10 hours at p75 and 64 hours at
p90; 44 closed without merging; 39 open, the oldest 10 days.

Measure the same numbers after two weeks, plus merge conflicts, review
findings per pull request, and how often the maintainer had to step in.

**Exit:** two weeks of data, and a written comparison that includes whatever
got worse.

## 2. Make the rules testable

- Mark each rule MUST or SHOULD.
- Group the rules into levels:
  - **L1:** one agent, good hygiene.
  - **L2:** solo with helpers.
  - **L3:** a full fleet.
- Pair every rule that can be checked with a concrete check. Lane coverage,
  guide paths, labels and cleanup can all be checked.
- Fold in what the trial taught.

**Exit:** every rule has a level and either a check or an explicit "review
only".

## 3. A reference implementation

A Claude Code plugin that implements L3:

- the lead's instructions;
- the worker protocol and brief template;
- the read-only reviewer;
- the herdr adapter.

It also includes `agents doctor`, which audits any repository against the
standard:

- lanes defined, with every file owned exactly once;
- paths cited in `AGENTS.md` still exist;
- stale worktrees and branches;
- wildcard permissions;
- unlabelled pull requests.

**Exit:** `agents doctor` passes on `vitest-native`, and a fresh repository
reaches L2 by following the plugin alone.

## 4. Prove it isn't tied to one tool

Add a second adapter (Codex or OpenCode), and run one lane with it during a
trial week.

**Exit:** the same lane's work completes under both tools with no change to
the rules.

## 5. Publish

Write up the trial with its numbers, both before and after, including what
didn't work. Publish it with the standard and the plugin.

**Exit:** the write-up, the standard and the plugin are public and link to
each other.

## Later: interoperability between agents

Messages between agents are designed to map one to one onto the
[A2A](https://a2a-protocol.org) task lifecycle:

| This standard | A2A task state |
| --- | --- |
| assigned, working | `submitted`, `working` |
| `QUESTION`, `BLOCKED` | `input-required` |
| `PR opened` | `completed`, with the pull request as the artifact |
| abandoned | `canceled` or `failed` |

Build the A2A adapter and publish Agent Cards for the lead and lane-worker
roles once there's a need: workers from different tools under one lead, or
workers running remotely. Until then, the mapping keeps the door open at no
cost.
