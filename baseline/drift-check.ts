#!/usr/bin/env node
// Checks every public repository against baseline.json and reports drift.
//
//   GH_TOKEN=$(gh auth token) node baseline/drift-check.ts [options]
//
//   --repo <name>       check one repository instead of all of them
//   --zizmor            also run zizmor (needs `uvx` on PATH)
//   --json <file>       write the raw results as JSON
//   --fail-on-drift     exit 1 when any check fails
//
// The token needs read access to repository administration (settings,
// rulesets, branch protection), contents, pull requests, Dependabot alerts,
// Actions, secrets, Dependabot secrets and environments. A token without write
// access cannot see rulesets' bypass actors; the report says so rather than
// guessing. No runtime dependencies: Node 24+ runs this file directly.

import { writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { loadBaseline, loadRegistry, type Check, type CheckId, type Exception, type Tier } from './config.ts';
import { Reader, isObject } from './json.ts';

const run = promisify(execFile);

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    zizmor: { type: 'boolean', default: false },
    json: { type: 'string' },
    'fail-on-drift': { type: 'boolean', default: false },
  },
});

const token = process.env['GH_TOKEN'] ?? process.env['GITHUB_TOKEN'];
if (token === undefined || token === '') {
  console.error('Set GH_TOKEN (for example GH_TOKEN=$(gh auth token)).');
  process.exit(2);
}

const baseline = await loadBaseline(new URL('baseline.json', import.meta.url));
const registry = await loadRegistry(new URL('repos.json', import.meta.url));
const OWNER = baseline.owner;
const ACTIONS_APP_ID = 15368;
const DAY = 86_400_000;
const ZIZMOR = 'zizmor==1.31.1';

// --- GitHub API -------------------------------------------------------------

class ApiError extends Error {
  readonly kind = 'api';
  readonly status: number;

  constructor(path: string, status: number, body: string) {
    super(`GET ${path} -> ${status}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

type ApiResponse = {
  readonly status: number;
  /** The parsed JSON body; `undefined` for 204 and for an allowed error status. */
  readonly body: unknown;
  readonly link: string | null;
};

async function api(path: string, { allow = [] }: { readonly allow?: readonly number[] } = {}): Promise<ApiResponse> {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${OWNER}-standards-drift-check`,
    },
  });
  if (allow.includes(res.status) || res.status === 204) return { status: res.status, body: undefined, link: null };
  if (!res.ok) throw new ApiError(path, res.status, await res.text());
  return { status: res.status, body: new Reader(`GET ${path}`).parse(await res.text()), link: res.headers.get('link') };
}

/** A reader whose errors name the request the body came from. */
const from = (path: string): Reader => new Reader(`GET ${path}`);

/** Every item across all pages. `key` names the array for endpoints that wrap it in an object. */
async function paginate(path: string, key?: 'workflows' | 'secrets'): Promise<readonly unknown[]> {
  const items: unknown[] = [];
  let next: string | undefined = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (next !== undefined) {
    const { body, link }: ApiResponse = await api(next);
    const r = from(next);
    items.push(...(key === undefined ? r.array(body, '(body)') : r.array(r.object(body, '(body)')[key], key)));
    next = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/)?.[1];
  }
  return items;
}

async function fileText(repo: string, path: string): Promise<string | null> {
  const url = `/repos/${OWNER}/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`;
  const { body } = await api(url, { allow: [404] });
  if (body === undefined) return null;
  const r = from(url);
  return Buffer.from(r.string(r.object(body, '(body)')['content'], 'content'), 'base64').toString('utf8');
}

/** The field `key` of an object response, read by `read`. */
async function field<T>(path: string, key: string, read: (r: Reader, value: unknown) => T): Promise<T> {
  const r = from(path);
  return read(r, r.object((await api(path)).body, '(body)')[key]);
}

// --- GitHub types -----------------------------------------------------------
// Only the fields the checks read, narrowed from each response.

type RepoMeta = {
  readonly name: string;
  readonly defaultBranch: string;
  /** Feature name to status; `undefined` when the token can't see it. */
  readonly securityAndAnalysis: ReadonlyMap<string, string> | undefined;
};

function readRepoMeta(r: Reader, body: unknown): RepoMeta {
  const o = r.object(body, '(body)');
  const sa = r.optional(o['security_and_analysis'], (v) => r.object(v, 'security_and_analysis'));
  return {
    name: r.string(o['name'], 'name'),
    defaultBranch: r.string(o['default_branch'], 'default_branch'),
    securityAndAnalysis:
      sa === undefined
        ? undefined
        : new Map(
            Object.entries(sa).flatMap(([feature, value]) => {
              const status = isObject(value) ? value['status'] : undefined;
              return typeof status === 'string' ? [[feature, status] as const] : [];
            }),
          ),
  };
}

type RequiredCheck = { readonly context: string; readonly integrationId: number | undefined };
type Rule = { readonly type: string; readonly requiredChecks: readonly RequiredCheck[] };
type Ruleset = {
  readonly target: string;
  readonly enforcement: string;
  readonly include: readonly string[];
  readonly rules: readonly Rule[];
  /** How many bypass actors; `undefined` when the token can't see them. */
  readonly bypassActors: number | undefined;
};

function readRuleset(r: Reader, body: unknown): Ruleset {
  const o = r.object(body, '(body)');
  const conditions = r.optional(o['conditions'], (v) => r.object(v, 'conditions'));
  const refName = r.optional(conditions?.['ref_name'], (v) => r.object(v, 'conditions.ref_name'));
  return {
    target: r.string(o['target'], 'target'),
    enforcement: r.string(o['enforcement'], 'enforcement'),
    include: r.optional(refName?.['include'], (v) => r.strings(v, 'conditions.ref_name.include')) ?? [],
    rules:
      r.optional(o['rules'], (v) =>
        r.items(v, 'rules', (raw, f): Rule => {
          const rule = r.object(raw, f);
          const parameters = r.optional(rule['parameters'], (p) => r.object(p, `${f}.parameters`));
          const checks = r.optional(parameters?.['required_status_checks'], (c) =>
            r.items(c, `${f}.parameters.required_status_checks`, (rawCheck, cf): RequiredCheck => {
              const check = r.object(rawCheck, cf);
              return {
                context: r.string(check['context'], `${cf}.context`),
                integrationId: r.optional(check['integration_id'], (id) => r.number(id, `${cf}.integration_id`)),
              };
            }),
          );
          return { type: r.string(rule['type'], `${f}.type`), requiredChecks: checks ?? [] };
        }),
      ) ?? [],
    bypassActors: r.optional(o['bypass_actors'], (v) => r.array(v, 'bypass_actors').length),
  };
}

type Workflow = { readonly id: number; readonly name: string; readonly state: string; readonly path: string };

function readWorkflow(r: Reader, raw: unknown, f: string): Workflow {
  const w = r.object(raw, f);
  return {
    id: r.number(w['id'], `${f}.id`),
    name: r.string(w['name'], `${f}.name`),
    state: r.string(w['state'], `${f}.state`),
    path: r.string(w['path'], `${f}.path`),
  };
}

async function workflowsOf(repo: string): Promise<readonly Workflow[]> {
  const path = `/repos/${OWNER}/${repo}/actions/workflows`;
  const r = from(path);
  return (await paginate(path, 'workflows')).map((raw, i) => readWorkflow(r, raw, `workflows[${i}]`));
}

async function secretNames(path: string): Promise<readonly string[]> {
  const r = from(path);
  return (await paginate(path, 'secrets')).map((raw, i) => r.string(r.object(raw, `secrets[${i}]`)['name'], `secrets[${i}].name`));
}

// --- Results ----------------------------------------------------------------

type Status = 'pass' | 'fail' | 'skip' | 'error' | 'excused';
type CheckResult = { readonly status: Status; readonly detail: string };
type Row = CheckResult & { readonly repo: string; readonly check: CheckId };

const pass = (detail = ''): CheckResult => ({ status: 'pass', detail });
const fail = (detail: string): CheckResult => ({ status: 'fail', detail });
const skip = (detail: string): CheckResult => ({ status: 'skip', detail });
const error = (detail: string): CheckResult => ({ status: 'error', detail });

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function appliesTo(check: Check, tier: Tier): boolean {
  return check.tiers === 'all' || check.tiers.includes(tier);
}

// --- Checks -----------------------------------------------------------------
// Each check receives a lazily-populated context for one repository and
// returns pass/fail/skip. Fetches are memoised so checks can share them.

type WorkflowFile = { readonly path: string; readonly text: string };

type Context = {
  readonly repo: string;
  readonly meta: RepoMeta;
  readonly rulesets: () => Promise<readonly Ruleset[]>;
  readonly tree: () => Promise<ReadonlySet<string>>;
  readonly workflows: () => Promise<readonly WorkflowFile[]>;
};

/** Runs `fn` on the first call and returns the same promise after that. */
function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | undefined;
  return () => (promise ??= fn());
}

function context(repo: string, meta: RepoMeta): Context {
  const tree = once(async () => {
    const path = `/repos/${OWNER}/${repo}/git/trees/${meta.defaultBranch}?recursive=1`;
    const { body } = await api(path, { allow: [404, 409] });
    if (body === undefined) return new Set<string>();
    const r = from(path);
    const o = r.object(body, '(body)');
    if (o['truncated'] === true) throw new Error('git tree is truncated; file checks would be incomplete');
    const entries = r.items(o['tree'], 'tree', (raw, f) => {
      const e = r.object(raw, f);
      return { type: r.string(e['type'], `${f}.type`), path: r.string(e['path'], `${f}.path`) };
    });
    return new Set(entries.filter((e) => e.type === 'blob').map((e) => e.path));
  });
  return {
    repo,
    meta,
    tree,
    rulesets: once(async () => {
      const path = `/repos/${OWNER}/${repo}/rulesets?includes_parents=false`;
      const r = from(path);
      const ids = (await paginate(path)).map((raw, i) => r.number(r.object(raw, `[${i}]`)['id'], `[${i}].id`));
      return Promise.all(
        ids.map(async (id) => {
          const one = `/repos/${OWNER}/${repo}/rulesets/${id}`;
          return readRuleset(from(one), (await api(one)).body);
        }),
      );
    }),
    workflows: once(async () => {
      const paths = [...(await tree())].filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
      return Promise.all(paths.map(async (path) => ({ path, text: (await fileText(repo, path)) ?? '' })));
    }),
  };
}

const branchTargetsDefault = (ruleset: Ruleset, defaultBranch: string): boolean =>
  ruleset.target === 'branch' &&
  ruleset.enforcement === 'active' &&
  ruleset.include.some((ref) => ref === '~DEFAULT_BRANCH' || ref === `refs/heads/${defaultBranch}` || ref === '~ALL');

const ruleTypes = (ruleset: Ruleset): ReadonlySet<string> => new Set(ruleset.rules.map((r) => r.type));

// GitHub returns bypass_actors only to tokens with write access to the ruleset.
const bypassState = (ruleset: Ruleset): 'unknown' | 'none' | 'some' =>
  ruleset.bypassActors === undefined ? 'unknown' : ruleset.bypassActors === 0 ? 'none' : 'some';

function verdictWithBypass(matches: readonly Ruleset[], what: string): CheckResult {
  if (matches.length === 0) return fail(what);
  if (matches.some((r) => bypassState(r) === 'none')) return pass();
  if (matches.every((r) => bypassState(r) === 'some')) return fail(`${what.replace(/^no /, '')} exists but has bypass actors`);
  return pass('bypass actors not visible to this token');
}

// Splits dependabot.yml's `updates:` sequence into its items. Handles items at
// any indentation (including none), comments anywhere, and keys in any order.
function dependabotItems(text: string): string[][] | null {
  const lines = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, ''));
  const start = lines.findIndex((l) => /^updates:\s*$/.test(l));
  if (start === -1) return null;
  const indentOf = (l: string): number => (l.match(/^ */)?.[0] ?? '').length;
  const first = lines.slice(start + 1).find((l) => l.trim() !== '');
  if (first === undefined || !/^\s*-(\s|$)/.test(first)) return null;
  const itemIndent = indentOf(first);
  const items: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const isItem = indent === itemIndent && /^\s*-(\s|$)/.test(line);
    if (indent < itemIndent || (indent === itemIndent && !isItem)) break;
    if (isItem) items.push([]);
    items.at(-1)?.push(line);
  }
  return items;
}

let defaultSecurityPolicy: Promise<string | null> | undefined;

const SECONDS_PER_UNIT: ReadonlyMap<string, number> = new Map([
  ['s', 1],
  ['m', 60],
  ['h', 3_600],
  ['d', 86_400],
  ['w', 604_800],
]);

// bunfig accepts seconds or a quoted duration such as "7d" or "2 weeks".
function parseDuration(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const value = raw.replace(/^["']|["']$/g, '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|w|weeks?)$/i);
  const unit = SECONDS_PER_UNIT.get(match?.[2]?.charAt(0).toLowerCase() ?? '');
  return match?.[1] !== undefined && unit !== undefined ? Number(match[1]) * unit : 0;
}

const CHECKS: { readonly [id: CheckId]: (ctx: Context) => Promise<CheckResult> } = {
  async 'settings.private-vulnerability-reporting'({ repo }) {
    const enabled = await field(`/repos/${OWNER}/${repo}/private-vulnerability-reporting`, 'enabled', (r, v) => r.boolean(v, 'enabled'));
    return enabled ? pass() : fail('private vulnerability reporting is off');
  },

  async 'settings.dependabot-alerts'({ repo }) {
    const { status } = await api(`/repos/${OWNER}/${repo}/vulnerability-alerts`, { allow: [404] });
    return status === 204 ? pass() : fail('Dependabot alerts are off');
  },

  async 'settings.dependabot-security-updates'({ repo }) {
    const path = `/repos/${OWNER}/${repo}/automated-security-fixes`;
    const { body } = await api(path, { allow: [404] });
    const r = from(path);
    const enabled = body !== undefined && r.boolean(r.object(body, '(body)')['enabled'], 'enabled');
    return enabled ? pass() : fail('Dependabot security updates are off');
  },

  async 'settings.secret-scanning'({ meta }) {
    const sa = meta.securityAndAnalysis;
    if (sa === undefined) return error('security_and_analysis not visible to this token (needs Administration: read)');
    const off = ['secret_scanning', 'secret_scanning_push_protection'].filter((k) => sa.get(k) !== 'enabled');
    return off.length === 0 ? pass() : fail(`not enabled: ${off.join(', ')}`);
  },

  async 'settings.workflow-token'({ repo }) {
    const path = `/repos/${OWNER}/${repo}/actions/permissions/workflow`;
    const r = from(path);
    const body = r.object((await api(path)).body, '(body)');
    const permissions = r.string(body['default_workflow_permissions'], 'default_workflow_permissions');
    const problems: string[] = [];
    if (permissions !== 'read') problems.push(`default token is ${permissions}`);
    if (r.boolean(body['can_approve_pull_request_reviews'], 'can_approve_pull_request_reviews')) {
      problems.push('Actions can approve pull requests');
    }
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },

  async 'rulesets.no-classic-protection'({ repo, meta }) {
    const { status } = await api(`/repos/${OWNER}/${repo}/branches/${meta.defaultBranch}/protection`, {
      allow: [404],
    });
    return status === 404 ? pass() : fail(`${meta.defaultBranch} still has classic branch protection`);
  },

  async 'rulesets.main-protected'(ctx) {
    const matches = (await ctx.rulesets())
      .filter((r) => branchTargetsDefault(r, ctx.meta.defaultBranch))
      .filter((r) => ruleTypes(r).has('deletion') && ruleTypes(r).has('non_fast_forward'));
    return verdictWithBypass(matches, 'no active ruleset blocks deletion and force-push on the default branch');
  },

  async 'rulesets.main-pr-required'(ctx) {
    const rulesets = (await ctx.rulesets()).filter((r) => branchTargetsDefault(r, ctx.meta.defaultBranch));
    const rules = rulesets.flatMap((r) => r.rules);
    const pr = rules.some((r) => r.type === 'pull_request');
    const checks = rules.filter((r) => r.type === 'required_status_checks').flatMap((r) => r.requiredChecks);
    if (!pr) return fail('pull requests are not required on the default branch');
    if (!checks.some((c) => c.integrationId === ACTIONS_APP_ID)) {
      return fail('no required status check reported by the GitHub Actions app');
    }
    // Any app may report a check (code scanning reports "CodeQL"), but each one
    // must be pinned to its app, or another app can satisfy it by name.
    const unpinned = checks.filter((c) => c.integrationId === undefined).map((c) => c.context);
    return unpinned.length === 0 ? pass() : fail(`required checks not pinned to an app: ${unpinned.join(', ')}`);
  },

  async 'rulesets.release-tags-locked'(ctx) {
    const matches = (await ctx.rulesets()).filter(
      (r) =>
        r.target === 'tag' &&
        r.enforcement === 'active' &&
        (r.include.includes('refs/tags/v*') || r.include.includes('~ALL')) &&
        ['deletion', 'non_fast_forward', 'update'].every((t) => ruleTypes(r).has(t)),
    );
    return verdictWithBypass(matches, 'no active tag ruleset locks refs/tags/v*');
  },

  async 'files.security-policy'(ctx) {
    const tree = await ctx.tree();
    const own = ['SECURITY.md', '.github/SECURITY.md', 'docs/SECURITY.md'].find((p) => tree.has(p));
    let text: string | null;
    let source: string;
    if (own !== undefined) {
      text = await fileText(ctx.repo, own);
      source = own;
    } else {
      defaultSecurityPolicy ??= (async () => {
        for (const path of ['SECURITY.md', '.github/SECURITY.md', 'docs/SECURITY.md']) {
          const found = await fileText('.github', path);
          if (found !== null) return found;
        }
        return null;
      })();
      text = await defaultSecurityPolicy;
      source = 'the .github default';
    }
    if (text === null) return fail(own !== undefined ? `${own} could not be read` : 'no SECURITY.md and no .github default');
    const emails = [...new Set(text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [])];
    const foreign = emails.filter(
      (e) => !baseline.contactDomains.some((d) => e.toLowerCase().endsWith(`@${d}`) || e.toLowerCase().endsWith(`.${d}`)),
    );
    return foreign.length === 0
      ? pass(source)
      : fail(`${source} names addresses outside the contact domains: ${foreign.join(', ')}`);
  },

  async 'files.dependabot'(ctx) {
    const paths = [...(await ctx.tree())].filter((p) => !p.includes('node_modules/'));
    const has = (re: RegExp): boolean => paths.some((p) => re.test(p));
    // Each entry lists the ecosystems that satisfy one need, preferred first.
    const expected: (readonly [string, ...string[]])[] = [];
    if (has(/(^|\/)bun\.lockb?$/)) expected.push(['bun']);
    else if (has(/(^|\/)package\.json$/)) expected.push(['npm', 'bun']);
    if (has(/(^|\/)Cargo\.toml$/)) expected.push(['cargo']);
    if (has(/(^|\/)go\.mod$/)) expected.push(['gomod']);
    if (has(/(^|\/)requirements[^/]*\.txt$/)) expected.push(['pip']);
    if (has(/(^|\/)pyproject\.toml$/)) expected.push(has(/(^|\/)uv\.lock$/) ? ['uv', 'pip'] : ['pip', 'uv']);
    if (has(/^\.github\/workflows\/[^/]+\.ya?ml$/)) expected.push(['github-actions']);
    if (expected.length === 0) return skip('nothing for Dependabot to update');
    const path = ['.github/dependabot.yml', '.github/dependabot.yaml'].find((p) => paths.includes(p));
    if (path === undefined) return fail(`no dependabot.yml (needed for: ${expected.map((e) => e[0]).join(', ')})`);
    const items = dependabotItems((await fileText(ctx.repo, path)) ?? '');
    if (items === null) return fail(`${path} has no updates list`);
    const entries = items.map((item) => {
      const body = item.join('\n');
      return {
        ecosystem: body.match(/package-ecosystem:\s*["']?([\w-]+)/)?.[1] ?? '?',
        days: Number(body.match(/default-days:\s*(\d+)/)?.[1] ?? 0),
      };
    });
    const configured = entries.map((e) => e.ecosystem);
    const missing = expected.filter((options) => !options.some((o) => configured.includes(o))).map((o) => o[0]);
    const short = entries.filter((e) => e.days < 7).map((e) => `${e.ecosystem} (${e.days || 'none'})`);
    const problems: string[] = [];
    if (missing.length > 0) problems.push(`ecosystems not covered: ${missing.join(', ')}`);
    if (short.length > 0) problems.push(`cooldown default-days under 7 on: ${short.join(', ')}`);
    return problems.length === 0 ? pass(configured.join(', ')) : fail(problems.join('; '));
  },

  async 'files.releasing-doc'(ctx) {
    const tree = await ctx.tree();
    return tree.has('RELEASING.md') || tree.has('docs/RELEASING.md') ? pass() : fail('no RELEASING.md');
  },

  async 'files.release-age'(ctx) {
    const tree = await ctx.tree();
    if (!tree.has('bun.lock') && !tree.has('bun.lockb')) return skip('not a Bun project');
    const text = tree.has('bunfig.toml') ? await fileText(ctx.repo, 'bunfig.toml') : null;
    const raw = text?.match(/^\s*minimumReleaseAge\s*=\s*("[^"]*"|'[^']*'|\d+)/m)?.[1];
    const seconds = parseDuration(raw);
    return seconds >= baseline.minimumReleaseAgeSeconds
      ? pass(`${seconds / 86_400} days`)
      : fail(raw !== undefined ? `minimumReleaseAge is ${raw} (${seconds}s)` : 'no bunfig.toml with minimumReleaseAge');
  },

  async 'files.trusted-dependencies'(ctx) {
    const tree = await ctx.tree();
    if (!tree.has('bun.lock') && !tree.has('bun.lockb')) return skip('not a Bun project');
    const r = new Reader(`${ctx.repo}/package.json`);
    const pkg = r.object(r.parse((await fileText(ctx.repo, 'package.json')) ?? '{}'), '(document)');
    const trusted = pkg['trustedDependencies'];
    if (Array.isArray(trusted)) {
      const names = r.strings(trusted, 'trustedDependencies');
      return pass(names.length === 0 ? 'empty' : names.join(', '));
    }
    const bunfig = tree.has('bunfig.toml') ? await fileText(ctx.repo, 'bunfig.toml') : null;
    if (/^\s*ignoreScripts\s*=\s*true/m.test(bunfig ?? '')) return pass('ignoreScripts = true');
    return fail("package.json has no trustedDependencies, so Bun's built-in allow-list runs install scripts");
  },

  async 'workflows.active'({ repo }) {
    const off = (await workflowsOf(repo)).filter((w) => w.state !== 'active').map((w) => `${w.name} (${w.state})`);
    return off.length === 0 ? pass() : fail(`disabled: ${off.join(', ')}`);
  },

  async 'workflows.main-green'({ repo, meta }) {
    const workflows = (await workflowsOf(repo)).filter(
      // Dynamic workflows (Dependabot, Pages builds) are GitHub's, not ours.
      (w) => w.state === 'active' && !w.path.startsWith('dynamic/'),
    );
    const path = `/repos/${OWNER}/${repo}/actions/runs?branch=${encodeURIComponent(meta.defaultBranch)}&exclude_pull_requests=true&per_page=100`;
    const runs = await field(path, 'workflow_runs', (r, v) =>
      r.items(v, 'workflow_runs', (raw, f) => {
        const run = r.object(raw, f);
        return {
          workflowId: r.number(run['workflow_id'], `${f}.workflow_id`),
          status: r.string(run['status'], `${f}.status`),
          conclusion: r.optional(run['conclusion'], (c) => r.string(c, `${f}.conclusion`)),
          createdAt: r.string(run['created_at'], `${f}.created_at`),
        };
      }),
    );
    const ignored = new Set(['skipped', 'cancelled', 'neutral', 'stale']);
    const red: string[] = [];
    for (const workflow of workflows) {
      const latest = runs.find(
        (r) =>
          r.workflowId === workflow.id &&
          r.status === 'completed' &&
          r.conclusion !== undefined &&
          !ignored.has(r.conclusion),
      );
      if (latest !== undefined && latest.conclusion !== 'success') {
        red.push(`${workflow.name} (${latest.conclusion} ${latest.createdAt.slice(0, 10)})`);
      }
    }
    return red.length === 0 ? pass() : fail(`latest run on ${meta.defaultBranch} not green: ${red.join(', ')}`);
  },

  async 'workflows.frozen-installs'(ctx) {
    const problems: string[] = [];
    for (const { path, text } of await ctx.workflows()) {
      text.split('\n').forEach((line, i) => {
        const code = line.replace(/(^|\s)#.*$/, '');
        // Step names and echoed text mention installs without running them.
        if (/^\s*-?\s*name:/.test(code) || /\becho\b/.test(code)) return;
        const global = /\s(-g|--global)\b/.test(code);
        const unfrozen =
          (/\b(bun|pnpm)\s+(install|i)\b/.test(code) && !global && !code.includes('--frozen-lockfile')) ||
          (/\byarn\s+install\b/.test(code) && !/--(frozen-lockfile|immutable)\b/.test(code)) ||
          (/\bnpm\s+(install|i)\b/.test(code) && !global);
        if (unfrozen) problems.push(`${path}:${i + 1}`);
      });
    }
    return problems.length === 0 ? pass() : fail(`unfrozen install at ${problems.join(', ')}`);
  },

  async 'workflows.audit'(ctx) {
    const pattern = /\b(bun audit|pnpm audit|cargo audit|cargo deny|govulncheck)\b|rustsec\/audit-check|cargo-deny-action|\bnpm audit(?! signatures)\b/;
    const found = (await ctx.workflows()).find(({ text }) => pattern.test(text));
    return found !== undefined ? pass(found.path) : fail('no workflow audits dependencies');
  },

  async 'workflows.zizmor'({ repo }) {
    if (!args.zizmor) return skip('run with --zizmor');
    let stdout: string;
    try {
      ({ stdout } = await run('uvx', ['--from', ZIZMOR, 'zizmor', '--format', 'json', `${OWNER}/${repo}`], {
        env: { ...process.env, GH_TOKEN: token },
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (e) {
      // zizmor exits non-zero when it reports findings; its JSON is still on stdout.
      const out = isObject(e) ? e['stdout'] : undefined;
      if (typeof out !== 'string' || out.trim() === '') {
        const stderr = isObject(e) ? e['stderr'] : undefined;
        if (typeof stderr === 'string' && /no inputs collected/.test(stderr)) return skip('no workflows');
        throw e;
      }
      stdout = out;
    }
    const r = new Reader(`zizmor ${repo}`);
    const findings = r
      .items(r.parse(stdout), '(findings)', (raw, f) => {
        const finding = r.object(raw, f);
        const determinations = r.optional(finding['determinations'], (d) => r.object(d, `${f}.determinations`));
        return {
          ident: r.string(finding['ident'], `${f}.ident`),
          severity: r.optional(determinations?.['severity'], (s) => r.string(s, `${f}.determinations.severity`)),
        };
      })
      .filter((f) => f.severity !== 'Informational');
    if (findings.length === 0) return pass();
    const counts = [...Map.groupBy(findings, (f) => f.ident)].map(([id, fs]) => `${id} x${fs.length}`);
    return fail(counts.join(', '));
  },

  async 'deps.dependabot-backlog'({ repo }) {
    const path = `/repos/${OWNER}/${repo}/pulls?state=open`;
    const r = from(path);
    const prs = (await paginate(path)).map((raw, i) => {
      const pr = r.object(raw, `[${i}]`);
      const user = r.optional(pr['user'], (u) => r.object(u, `[${i}].user`));
      return {
        number: r.number(pr['number'], `[${i}].number`),
        createdAt: r.string(pr['created_at'], `[${i}].created_at`),
        login: r.optional(user?.['login'], (l) => r.string(l, `[${i}].user.login`)),
      };
    });
    const cutoff = Date.now() - baseline.staleDependabotDays * DAY;
    const stale = prs.filter((p) => p.login === 'dependabot[bot]' && Date.parse(p.createdAt) < cutoff);
    return stale.length === 0
      ? pass()
      : fail(`${stale.length} Dependabot PR(s) older than ${baseline.staleDependabotDays} days: ${stale.map((p) => `#${p.number}`).join(', ')}`);
  },

  async 'deps.open-alerts'({ repo }) {
    const path = `/repos/${OWNER}/${repo}/dependabot/alerts?state=open&severity=high,critical`;
    let alerts: readonly unknown[];
    try {
      alerts = await paginate(path);
    } catch (e) {
      // 403 with "disabled" means alerts are off (reported by its own check);
      // any other 403 is a missing permission, which must not pass silently.
      if (e instanceof ApiError && e.status === 403 && /disabled/i.test(e.message)) return skip('Dependabot alerts are off');
      throw e;
    }
    const names = alerts.map((raw) => {
      const dependency = isObject(raw) ? raw['dependency'] : undefined;
      const pkg = isObject(dependency) ? dependency['package'] : undefined;
      const name = isObject(pkg) ? pkg['name'] : undefined;
      return typeof name === 'string' ? name : 'unknown package';
    });
    return alerts.length === 0
      ? pass()
      : fail(`${alerts.length} open high/critical alert(s): ${[...new Set(names)].join(', ')}`);
  },

  async 'secrets.no-registry-tokens'({ repo }) {
    const names = [...(await secretNames(`/repos/${OWNER}/${repo}/actions/secrets`))];
    names.push(...(await secretNames(`/repos/${OWNER}/${repo}/dependabot/secrets`)).map((s) => `dependabot/${s}`));
    const environments = await field(`/repos/${OWNER}/${repo}/environments?per_page=100`, 'environments', (r, v) =>
      r.optional(v, (list) => r.items(list, 'environments', (raw, f) => r.string(r.object(raw, f)['name'], `${f}.name`))) ?? [],
    );
    for (const env of environments) {
      const secrets = await secretNames(`/repos/${OWNER}/${repo}/environments/${encodeURIComponent(env)}/secrets`);
      names.push(...secrets.map((s) => `${env}/${s}`));
    }
    const pattern = /NPM_TOKEN|NODE_AUTH_TOKEN|CARGO_REGISTRY_TOKEN|_PAT$|^GH_PAT|^GH_TOKEN$|TAP_TOKEN/;
    const bad = names.filter((n) => pattern.test(n.split('/').at(-1) ?? n));
    return bad.length === 0 ? pass() : fail(`secrets that look like long-lived tokens: ${bad.join(', ')}`);
  },
};

// --- Driver -----------------------------------------------------------------

function applyException(result: CheckResult, { reason, until }: Exception): CheckResult {
  if (reason.trim() === '') return fail('exception has no reason');
  if (until !== undefined && !(Date.parse(until) > Date.now())) return fail(`exception expired on ${until}: ${reason}`);
  if (result.status === 'pass') return fail(`excused, but the check now passes - remove the exception (${reason})`);
  if (result.status === 'error') return result;
  return { status: 'excused', detail: until !== undefined ? `${reason} (until ${until})` : reason };
}

async function checkRepo(meta: RepoMeta): Promise<Row[]> {
  const repo = meta.name;
  const entry = registry.get(repo);
  if (entry === undefined) {
    return [{ repo, check: 'inventory.listed', ...fail('not in repos.json - assign a tier') }];
  }
  const rows: Row[] = [];
  const ctx = context(repo, meta);
  for (const check of baseline.checks) {
    if (!check.automated || check.id === 'inventory.listed' || !appliesTo(check, entry.tier)) continue;
    const implementation = CHECKS[check.id];
    let result: CheckResult;
    try {
      result = implementation === undefined ? error('no implementation in drift-check.ts') : await implementation(ctx);
    } catch (e) {
      result = error(messageOf(e));
    }
    const exception = entry.exceptions.get(check.id);
    if (exception !== undefined) result = applyException(result, exception);
    rows.push({ repo, check: check.id, ...result });
  }
  for (const id of entry.exceptions.keys()) {
    if (!baseline.checks.some((c) => c.id === id)) {
      rows.push({ repo, check: id, ...fail('exception names an unknown check') });
    }
  }
  return rows;
}

/** Maps `items` through `fn`, at most `limit` at a time, keeping their order. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  const queue = items.entries(); // shared, so each worker takes the next unclaimed item
  const worker = async (): Promise<void> => {
    for (const [index, item] of queue) out[index] = await fn(item);
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}

const listPath = `/users/${OWNER}/repos?type=owner`;
const listed = from(listPath);
const all = (await paginate(listPath))
  .map((raw, i) => {
    const o = listed.object(raw, `[${i}]`);
    return {
      name: listed.string(o['name'], `[${i}].name`),
      fork: listed.boolean(o['fork'], `[${i}].fork`),
      archived: listed.boolean(o['archived'], `[${i}].archived`),
      visibility: listed.string(o['visibility'], `[${i}].visibility`),
    };
  })
  .filter((r) => !r.fork && !r.archived && r.visibility === 'public');
const targets = args.repo !== undefined ? all.filter((r) => r.name === args.repo) : all;
if (args.repo !== undefined && targets.length === 0) {
  console.error(`${OWNER}/${args.repo} is not a public, non-archived repository.`);
  process.exit(2);
}

// `/users/{owner}/repos` omits security_and_analysis; fetch each repository.
const metas = await mapLimit(targets, 6, async (r) => {
  const path = `/repos/${OWNER}/${r.name}`;
  return readRepoMeta(from(path), (await api(path)).body);
});
const results: Row[] = (await mapLimit(metas, 4, checkRepo)).flat();

if (args.repo === undefined) {
  const publicNames = new Set(all.map((r) => r.name));
  for (const name of registry.keys()) {
    if (!publicNames.has(name)) {
      results.push({ repo: name, check: 'inventory.listed', ...fail('listed in repos.json but not a public repository') });
    }
  }
}

// --- Report -----------------------------------------------------------------

const count = (status: Status): number => results.filter((r) => r.status === status).length;
const failing = results.filter((r) => r.status === 'fail' || r.status === 'error');
const byRepo = Map.groupBy(failing, (r) => r.repo);
const docFor = (id: CheckId): string | undefined => baseline.checks.find((c) => c.id === id)?.doc;

const lines = [
  '# Standards drift report',
  '',
  `Checked ${new Set(results.map((r) => r.repo)).size} repositories against [the baseline](https://github.com/${OWNER}/standards/blob/main/baseline/baseline.json): ` +
    `**${count('fail')} failing**, ${count('error')} errors, ${count('excused')} excused, ${count('pass')} passing, ${count('skip')} not applicable.`,
  '',
];
if (failing.length === 0) {
  lines.push('No drift. Every repository meets its tier.');
} else {
  for (const [repo, rows] of [...byRepo].sort(([a], [b]) => a.localeCompare(b))) {
    const tier = registry.get(repo)?.tier;
    lines.push(`## ${repo}${tier !== undefined ? ` (${tier})` : ''}`, '');
    for (const r of rows) {
      const doc = docFor(r.check);
      const label = doc !== undefined ? `[\`${r.check}\`](https://github.com/${OWNER}/standards/blob/main/${doc})` : `\`${r.check}\``;
      lines.push(`- ${r.status === 'error' ? 'error: ' : ''}${label}: ${r.detail}`);
    }
    lines.push('');
  }
}
const excused = results.filter((r) => r.status === 'excused');
if (excused.length > 0) {
  lines.push('<details><summary>Excused checks</summary>', '');
  for (const r of excused) lines.push(`- ${r.repo} \`${r.check}\`: ${r.detail}`);
  lines.push('', '</details>');
}

console.log(lines.join('\n'));
if (args.json !== undefined) await writeFile(args.json, `${JSON.stringify(results, null, 2)}\n`);
if (args['fail-on-drift'] && failing.length > 0) process.exit(1);
