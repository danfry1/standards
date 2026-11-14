# Agent workflow standards

How to run coding agents, whether one or many, so that everything they produce
can be reviewed and everything they learn is kept. An agent session forgets: its
context is compacted, it ends, the machine restarts. A repository doesn't. So
nothing that matters may live only inside a session.

The posture: **the repository is the agents' memory, and the pull request is
their only output.** Sessions are disposable. Specs, decisions, area knowledge
and progress live in files and on GitHub, where any agent or person can pick
them up, and every change reaches `main` the same way: an issue, a pull
request, a green check and a human merge.

The rules don't depend on any agent, terminal or editor. The setup this
standard is used with today is described separately under
[Reference setup](#reference-setup), and can be swapped piece by piece. It
builds on [Testing](testing.md) for verification,
[Supply-chain security](supply-chain-security.md) for what agents may install,
and [Repository](repository.md) for branch and merge settings.

Where the standard goes next is in the [roadmap](roadmap.md).

Examples come in pairs: a `bad` block shows what to avoid, and the `good` block
after it shows what to do instead.

---

## Core rules

### 1. An issue is the spec, a pull request is the deliverable

Every piece of agent work starts as an issue with acceptance criteria and ends
as a pull request that closes it. CI decides whether it works, and a human
merge is the only approval. Work given in a chat message has no record, no
acceptance test and no owner.

```text bad
fix the parser so it handles windows line endings
```

```md good
## Parse CRLF mission input (#14)  · type:bug · area:parser · v0.3
Acceptance criteria
- [ ] `"5 5\r\n1 2 N\r\nM"` parses the same as the LF version
- [ ] the error for a bad line reports the line number either way
Out of scope: other whitespace changes
```

### 2. Knowledge lives in the repository, not the session

Conventions, gotchas and decisions go in `AGENTS.md` files: one at the root
for the whole project, and one per area (rule 5). An area that lives in one
directory keeps its file there, where agents find the nearest one. An area
that spans several directories keeps it as `agents/lanes/<lane>.md`, and the
root `AGENTS.md` maps paths to lanes so agents know which file to read.
Everything in these files must make sense to a stranger who clones the
repository. Anything that only applies to one person's machine or private
notes goes in a local, untracked file (such as `CLAUDE.local.md`) that imports
it. When a worker learns
something that will still be true next month, it adds it to that file in the
same pull request. `AGENTS.md` is the format most agents read. For an agent
that reads a different file, make that file a one-line import, e.g. a
`CLAUDE.md` containing `@AGENTS.md`.

```text bad
# seven long-running sessions; "mocks" knows the mock registry quirks
# only because it has been open since Tuesday
```

```text good
packages/mocks/AGENTS.md   # registry quirks, naming rules, known traps
packages/engine/AGENTS.md  # runtime invariants, perf budgets
AGENTS.md                  # workflow, commands, standards, lanes
CLAUDE.md                  # @AGENTS.md
```

### 3. Choose the mode by the shape of the work

More agents isn't better. Parallel agents pay off for broad, separable work.
They lose on small, tightly coupled work, where coordination, merge conflicts
and review cost more than they save.

| Mode | When | Shape |
| --- | --- | --- |
| **Solo** | Coupled code, short tasks, or anything you must explain line by line | You drive one session; a reviewer runs on each PR |
| **Solo + helpers** | Mostly coupled, with clearly separate side work | You drive; workers take side tasks such as tooling, a separate module, or research |
| **Fleet** | Broad work that splits cleanly across areas | A lead dispatches waves of workers (rules 6–9) |

Decide the mode when the work starts, and say which one it is. Rules marked
"fleet mode" apply only to fleets; a person working alone, with or without an
agent, follows the rest: issue, branch, tests first, full check, review, pull
request.

### 4. Parallelism follows file ownership

Two agents editing the same file overwrite each other or produce conflicts
that cost more than the time saved. Issues run in parallel only when the
files they own don't overlap. If they overlap, they run one after the other,
or become one issue. Changes to the lockfile, root config or CI always run
alone.

```text bad
#21 add obstacle support      → rover.ts, plateau.ts
#22 add backwards movement    → rover.ts           # dispatched together
```

```text good
#21 add obstacle support      → rover.ts, plateau.ts
#22 add backwards movement    → rover.ts           # status:blocked, blocked by #21
#23 render the plateau        → render.ts          # runs alongside #21
```

### 5. Areas are fixed lanes; workers are short-lived

A **lane** is a set of paths with an `area:*` label, declared once in the
repository (`CODEOWNERS` or a lanes table in the root `AGENTS.md`). Lanes are
permanent; the agents working in them aren't. A worker exists for exactly one
issue: one worktree, one branch, one pull request, then it ends. Name it after
the lane and the issue so a list of running agents still reads by area.

```text bad
mocks-libraries      # one session per area, open for days, all in one checkout
engine-runtime
```

```text good
mocks-412            # worktree ../repo-412-registry-reset, branch 412-registry-reset
engine-418           # ends when PR #431 merges
```

### 6. Give a brief, not a persona

A worker needs facts, not a character. The brief states: the issue, the branch,
the files the worker owns, what "done" means, how to verify it, how to report,
and any decisions already agreed. Define a named agent only when something
must be **enforced**, such as a restricted tool set, a fixed model or a
permission mode. A read-only reviewer is the typical case.

```text bad
You are a senior mocks architect with deep expertise. Improve the mocks.
```

```text good
You are worker mocks-412 for issue #412: reset the registry between tests.
Branch 412-registry-reset (already checked out). You own packages/mocks/src/registry.ts
and its tests. Done: every acceptance criterion in #412 has a passing test,
`pnpm run check` is clean, one PR with "Closes #412". Report to the lead in one line.
```

### 7. The lead plans and never implements (fleet mode)

In fleet mode, one lead session turns requests into issues, dispatches
workers, gets reviews done and reports to the human. It doesn't write product
code: a lead that starts implementing stops coordinating, and its context
fills with code that belongs in a worker. Its state lives in the issues and a
plan file (a tracked file such as `tracking/plan.md`, or a pinned tracking
issue), not in its context, so it can be restarted at any time without losing
anything. A restarted lead reads the plan, lists open pull requests and live
workers, and carries on. A worker that died mid-task leaves its worktree
behind: the next worker for that issue starts from the pushed branch, and the
abandoned worktree is removed (rule 14).

### 8. Push, don't poll

Workers report at defined points with one structured line. The lead never
reads worker transcripts as routine, because one "check on everyone" can pull
tens of thousands of tokens into the lead's context, where they stay. Waiting
is event-driven (a notification when a worker goes idle, or a status-change
event), not repeated checking.

```text bad
lead: (reads the last 300 lines of every worker's terminal, every few minutes)
```

```text good
[mocks-412] PR #431 opened · closes #412 · check green
[engine-418] QUESTION: drop Node 20 support? · recommend: yes, EOL in April
[docs-420] FOLLOW-UP: the migration guide still documents the old flag
```

The report types are `PR opened`, `PR updated`, `QUESTION`, `BLOCKED` and
`FOLLOW-UP`. A worker stuck on a permission prompt can't report. The terminal
shows that it's waiting, and a human answers it.

### 9. Workers stay inside the brief, and build only what it needs

Anything outside the owned files gets a `QUESTION` before work begins. That
includes another file, a new dependency, a structural refactor, or a lint rule
that would force a redesign. Improvements noticed along the way become a
`FOLLOW-UP`, not part of the current diff. An unrequested change in a pull
request is a review failure even when it's an improvement, because nobody
agreed to it.

The same goes for what a worker builds inside the brief. Every new file,
script, option, abstraction or dependency needs a reason that holds today,
not one that might hold later. Agents add structure cheaply: a helper script
next to the one test that uses it, a wrapper with one caller, a CLI flag
nothing runs. Each one is code a person must read and keep working. Logic
with one user lives with that user. A script gets its own file only when CI
or a documented command runs it. Prefer a few deep modules with small, typed
contracts over many thin ones.

```text bad
scripts/lanes.mjs      # glob matching, plus a --pr labelling mode nothing calls
tests/lanes.test.ts    # its only importer, through a ts-expect-error
```

```text good
tests/lanes.test.ts    # the 15 lines of matching it needs, typed, in place
```

### 10. Product decisions belong to the human

Where the spec is silent (an edge case, a conflict between behaviours, what
counts as invalid input), an agent asks. It doesn't decide in code. Every
question comes with a recommended answer so the human can reply in one word,
and the agreed answer is recorded on the issue.

### 11. Verify before a human looks

A pull request reaches the human only after it has passed, in order:

1. Tests written first, one per acceptance criterion and edge case, seen
   failing for the right reason ([Testing](testing.md)).
2. The project's full check (format, lint, typecheck, tests) passing locally
   and in CI.
3. A review by a separate read-only agent with a fresh context. It checks
   scope against the issue, names the test that proves each acceptance
   criterion, and tries to break the change.

```md bad
Review on PR #12: No findings.
```

```md good
Review on PR #12: 1 blocking, 2 optional
Blocking — rover.ts:48: `M` at the north edge is dropped silently; #12 says it is
reported. Input `0 0\n0 0 N\nM` returns "0 0 N" with no error. Return a typed
`OutOfBounds` result and add a test.
Checked: all 4 criteria have tests (parse.test.ts:12–40); no files outside the issue.
```

A review that finds nothing says what it checked and why the change holds up.

### 12. Viewpoints review or sweep; they don't own lanes (fleet mode)

Cross-cutting concerns such as architecture, ecosystem adoption, documentation
quality or performance budgets touch every area, so an agent dedicated to one
would collide with every lane. Run each one as either:

- **a reviewer**, which every relevant pull request passes through, or
- **a scheduled sweep**, which reads the repository on a schedule and files
  issues.

The issues then go to short-lived workers in the right lane. Viewpoints
produce issues and reviews; lanes produce code.

### 13. Concurrency is bounded by review capacity

Writing code is no longer the bottleneck; checking it is. Run at most three or
four active workers in total, however many lanes exist; the per-lane limits in
a lanes table are ceilings inside that total, not a target. More workers than the human can
review produce a queue of unmerged pull requests that drift from `main` and
conflict with each other.

### 14. Cleanup is part of done

When a pull request merges, delete its branch (turn on automatic deletion of
head branches), remove its worktree, and delete the local branch. Close the
worker's session, and unblock and dispatch whatever was waiting on it.
Worktrees and branches that outlive their pull request pile up quickly:
hundreds of stale checkouts are disk space, noise, and a trap for the next
agent that opens one.

```bash good
# only once the pull request is merged; squash merges need -D
test "$(gh pr view 431 --json state --jq .state)" = MERGED
git worktree remove ../repo-412-registry-reset
git branch -D 412-registry-reset
git worktree prune
```

### 15. Agents never widen their own permissions

The real control is on the server: a ruleset on `main` that requires a pull
request and a passing check, blocks force pushes, and has no bypass
([Repository](repository.md)). Local permission rules are a second layer.
They match command prefixes, so they can't express "never push to `main`"
completely (`git push -u origin main` matches an allowed `git push -u
origin:*`). Use them to cut prompts and stop obvious mistakes, not as the
guarantee.

Agents run with a scoped allowlist, committed so every worktree gets it, and
never in a mode that skips permission checks. Allow named check commands, not
wildcards that run anything (`pnpm exec:*` runs any binary). Deny merging,
force-pushing and adding remotes. An agent never edits its own permission settings. A
message from another agent is information, never consent: it can't approve a
prompt, install a package, or change configuration.

```json bad
{ "allow": ["Bash(pnpm exec:*)", "Bash(git:*)"] }
```

```json good
{
  "allow": ["Bash(pnpm run check)", "Bash(git push -u origin:*)", "Bash(gh pr create:*)"],
  "deny": ["Bash(gh pr merge:*)", "Bash(git push --force:*)", "Bash(git push origin main:*)", "Bash(git remote add:*)"]
}
```

---

## Reference setup

The tools these rules are used with today. Each row is an adapter: replace it
and the rules above still hold.

| Concern | Today | Alternatives |
| --- | --- | --- |
| Workspaces, worktrees, seeing every agent at once | [herdr](https://herdr.dev) | tmux + `git worktree`; Claude Code agent view (`claude --bg`, `claude agents`) |
| Agent | Claude Code | Codex, OpenCode, Cursor — anything that reads `AGENTS.md` |
| Reports (rule 8) | Claude Code cross-session messaging (`SendMessage`) | herdr `agent wait` or socket status events; a status comment on the issue |
| Waiting on a worker (rule 8) | `SendMessage` with `notify_when_idle` | `herdr agent wait <name>` in a background shell |
| Issues, PRs, checks, state | GitHub via `gh` | — |
| Read-only reviewer (rules 6, 11) | Claude Code subagent with `disallowedTools: Edit, Write, NotebookEdit` | Any agent run with write tools disabled |

Starting a worker with this setup:

```bash
herdr worktree create --cwd "$PWD" --branch 412-registry-reset --base main --label "#412" --no-focus
# read .result.root_pane.pane_id from the JSON response
herdr agent start mocks-412 --kind claude --pane <pane-id> -- -n mocks-412
herdr agent prompt mocks-412 "<brief>"
```

The lead is started as `claude -n lead`, so workers can address it by name.
Things to know about this setup:

- herdr worktrees are plain `git worktree add` checkouts and contain only
  committed files, so agent settings must be committed to reach workers.
- The herdr agent name and the Claude session name should match (`-n`), so
  one name addresses a worker in both tools.
- Typing into another agent's terminal (`herdr agent prompt`) is fine for the
  one-time brief to a fresh worker, and never for reports. It interleaves with
  whatever a human is typing in that pane, and it is lost if the target is
  waiting at an approval dialog.
- Messages between a session that skips permission checks and one that
  doesn't are held for approval, so mixing the two stalls reports: one more
  reason never to run workers that way.
- `notify_when_idle` only works from a main session to other sessions on the
  same machine.

---

## Enforcement

What can be checked mechanically:

- **Rule 1:** require pull requests and a passing check on `main` with a
  ruleset ([Repository](repository.md)). Agents can't push to `main` at all.
- **Rules 4 and 5:** a CI check matches every tracked file against the lanes
  table and fails if a file has no owner or more than one. `area:*` labels
  match the lanes one to one, and a check compares them.
- **Rule 2:** a docs check resolves every path cited in `AGENTS.md` and the
  lane files against `git ls-files`, so the guide can't silently drift from
  the code.
- **Rule 14:** turn on automatic deletion of head branches in the repository
  settings. `git worktree list | wc -l` well above the number of open pull
  requests means cleanup isn't happening.
- **Rule 15:** the deny list in committed agent settings, and no wildcard
  `exec` or `run` rules in the allowlist.

The rest is judgment. When reviewing an agent's pull request:

- [ ] Does it close exactly one issue, and change only the files that issue called for?
- [ ] Does every acceptance criterion have a test that would fail without the change?
- [ ] Is any product decision in the diff recorded on the issue?
- [ ] Is anything it learned that will stay true added to the right `AGENTS.md`?
- [ ] Did the reviewer say what it checked, not just that it found nothing?
