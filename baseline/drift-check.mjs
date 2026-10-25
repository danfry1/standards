#!/usr/bin/env node
// Checks every public repository against baseline.json and reports drift.
//
//   GH_TOKEN=$(gh auth token) node baseline/drift-check.mjs [options]
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
// guessing. Zero dependencies: Node 22+ only.

import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const run = promisify(execFile);
const here = (file) => new URL(file, import.meta.url);

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string' },
    zizmor: { type: 'boolean', default: false },
    json: { type: 'string' },
    'fail-on-drift': { type: 'boolean', default: false },
  },
});

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) {
  console.error('Set GH_TOKEN (for example GH_TOKEN=$(gh auth token)).');
  process.exit(2);
}

const baseline = JSON.parse(await readFile(here('baseline.json'), 'utf8'));
const registry = JSON.parse(await readFile(here('repos.json'), 'utf8')).repos;
const OWNER = baseline.owner;
const ACTIONS_APP_ID = 15368;
const DAY = 86_400_000;
const ZIZMOR = 'zizmor==1.31.1';

// --- GitHub API -------------------------------------------------------------

class ApiError extends Error {
  constructor(path, status, body) {
    super(`GET ${path} -> ${status}: ${body.slice(0, 200)}`);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function api(path, { allow = [] } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${OWNER}-standards-drift-check`,
    },
  });
  if (allow.includes(res.status)) return { status: res.status, body: null };
  if (res.status === 204) return { status: 204, body: null };
  if (!res.ok) throw new ApiError(path, res.status, await res.text());
  return { status: res.status, body: await res.json(), link: res.headers.get('link') };
}

async function paginate(path) {
  const items = [];
  let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (next) {
    const { body, link } = await api(next);
    items.push(...(Array.isArray(body) ? body : (body.workflows ?? body.secrets ?? [])));
    const match = link?.match(/<https:\/\/api\.github\.com([^>]+)>;\s*rel="next"/);
    next = match ? match[1] : null;
  }
  return items;
}

async function fileText(repo, path) {
  const res = await api(`/repos/${OWNER}/${repo}/contents/${encodeURIComponent(path).replaceAll('%2F', '/')}`, {
    allow: [404],
  });
  if (!res.body) return null;
  return Buffer.from(res.body.content, 'base64').toString('utf8');
}

// --- Results ----------------------------------------------------------------

const pass = (detail = '') => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });
const error = (detail) => ({ status: 'error', detail });

function appliesTo(check, tier) {
  return check.tiers === 'all' || check.tiers.includes(tier);
}

// --- Checks -----------------------------------------------------------------
// Each check receives a lazily-populated context for one repository and
// returns pass/fail/skip. Fetches are memoised so checks can share them.

function context(repo, meta) {
  const memo = new Map();
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };
  const ctx = {
    repo,
    meta,
    rulesets: () =>
      once('rulesets', async () => {
        const list = await paginate(`/repos/${OWNER}/${repo}/rulesets?includes_parents=false`);
        return Promise.all(list.map(async (r) => (await api(`/repos/${OWNER}/${repo}/rulesets/${r.id}`)).body));
      }),
    tree: () =>
      once('tree', async () => {
        const res = await api(`/repos/${OWNER}/${repo}/git/trees/${meta.default_branch}?recursive=1`, {
          allow: [404, 409],
        });
        if (res.body?.truncated) throw new Error('git tree is truncated; file checks would be incomplete');
        return new Set((res.body?.tree ?? []).filter((e) => e.type === 'blob').map((e) => e.path));
      }),
    workflows: () =>
      once('workflows', async () => {
        const paths = [...(await ctx.tree())].filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p));
        return Promise.all(paths.map(async (path) => ({ path, text: (await fileText(repo, path)) ?? '' })));
      }),
  };
  return ctx;
}

const branchTargetsDefault = (ruleset, defaultBranch) =>
  ruleset.target === 'branch' &&
  ruleset.enforcement === 'active' &&
  (ruleset.conditions?.ref_name?.include ?? []).some(
    (ref) => ref === '~DEFAULT_BRANCH' || ref === `refs/heads/${defaultBranch}` || ref === '~ALL',
  );

const ruleTypes = (ruleset) => new Set((ruleset.rules ?? []).map((r) => r.type));

// GitHub returns bypass_actors only to tokens with write access to the ruleset.
const bypassState = (ruleset) =>
  ruleset.bypass_actors === undefined ? 'unknown' : ruleset.bypass_actors.length === 0 ? 'none' : 'some';

function verdictWithBypass(matches, what) {
  if (matches.length === 0) return fail(what);
  if (matches.some((r) => bypassState(r) === 'none')) return pass();
  if (matches.every((r) => bypassState(r) === 'some')) return fail(`${what.replace(/^no /, '')} exists but has bypass actors`);
  return pass('bypass actors not visible to this token');
}

// Splits dependabot.yml's `updates:` sequence into its items. Handles items at
// any indentation (including none), comments anywhere, and keys in any order.
function dependabotItems(text) {
  const lines = text.split('\n').map((l) => l.replace(/(^|\s)#.*$/, ''));
  const start = lines.findIndex((l) => /^updates:\s*$/.test(l));
  if (start === -1) return null;
  const indentOf = (l) => l.match(/^ */)[0].length;
  const first = lines.slice(start + 1).find((l) => l.trim() !== '');
  if (first === undefined || !/^\s*-(\s|$)/.test(first)) return null;
  const itemIndent = indentOf(first);
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue;
    const indent = indentOf(line);
    const isItem = indent === itemIndent && /^\s*-(\s|$)/.test(line);
    if (indent < itemIndent || (indent === itemIndent && !isItem)) break;
    if (isItem) items.push([]);
    items.at(-1).push(line);
  }
  return items;
}

let defaultSecurityPolicy;

// bunfig accepts seconds or a quoted duration such as "7d" or "2 weeks".
function parseDuration(raw) {
  if (raw === undefined) return 0;
  const value = raw.replace(/^["']|["']$/g, '').trim();
  if (/^\d+$/.test(value)) return Number(value);
  const units = { s: 1, m: 60, h: 3_600, d: 86_400, w: 604_800 };
  const match = value.match(/^(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|h|hours?|d|days?|w|weeks?)$/i);
  return match ? Number(match[1]) * units[match[2][0].toLowerCase()] : 0;
}

const CHECKS = {
  async 'settings.private-vulnerability-reporting'({ repo }) {
    const { body } = await api(`/repos/${OWNER}/${repo}/private-vulnerability-reporting`);
    return body.enabled ? pass() : fail('private vulnerability reporting is off');
  },

  async 'settings.dependabot-alerts'({ repo }) {
    const { status } = await api(`/repos/${OWNER}/${repo}/vulnerability-alerts`, { allow: [404] });
    return status === 204 ? pass() : fail('Dependabot alerts are off');
  },

  async 'settings.dependabot-security-updates'({ repo }) {
    const { body } = await api(`/repos/${OWNER}/${repo}/automated-security-fixes`, { allow: [404] });
    return body?.enabled ? pass() : fail('Dependabot security updates are off');
  },

  async 'settings.secret-scanning'({ meta }) {
    const sa = meta.security_and_analysis;
    if (!sa) return error('security_and_analysis not visible to this token (needs Administration: read)');
    const off = ['secret_scanning', 'secret_scanning_push_protection'].filter((k) => sa[k]?.status !== 'enabled');
    return off.length === 0 ? pass() : fail(`not enabled: ${off.join(', ')}`);
  },

  async 'settings.workflow-token'({ repo }) {
    const { body } = await api(`/repos/${OWNER}/${repo}/actions/permissions/workflow`);
    const problems = [];
    if (body.default_workflow_permissions !== 'read') problems.push(`default token is ${body.default_workflow_permissions}`);
    if (body.can_approve_pull_request_reviews) problems.push('Actions can approve pull requests');
    return problems.length === 0 ? pass() : fail(problems.join('; '));
  },

  async 'rulesets.no-classic-protection'({ repo, meta }) {
    const { status } = await api(`/repos/${OWNER}/${repo}/branches/${meta.default_branch}/protection`, {
      allow: [404],
    });
    return status === 404 ? pass() : fail(`${meta.default_branch} still has classic branch protection`);
  },

  async 'rulesets.main-protected'(ctx) {
    const matches = (await ctx.rulesets())
      .filter((r) => branchTargetsDefault(r, ctx.meta.default_branch))
      .filter((r) => ruleTypes(r).has('deletion') && ruleTypes(r).has('non_fast_forward'));
    return verdictWithBypass(matches, 'no active ruleset blocks deletion and force-push on the default branch');
  },

  async 'rulesets.main-pr-required'(ctx) {
    const rulesets = (await ctx.rulesets()).filter((r) => branchTargetsDefault(r, ctx.meta.default_branch));
    const rules = rulesets.flatMap((r) => r.rules ?? []);
    const pr = rules.some((r) => r.type === 'pull_request');
    const checks = rules
      .filter((r) => r.type === 'required_status_checks')
      .flatMap((r) => r.parameters?.required_status_checks ?? []);
    if (!pr) return fail('pull requests are not required on the default branch');
    if (!checks.some((c) => c.integration_id === ACTIONS_APP_ID)) {
      return fail('no required status check reported by the GitHub Actions app');
    }
    // Any app may report a check (code scanning reports "CodeQL"), but each one
    // must be pinned to its app, or another app can satisfy it by name.
    const unpinned = checks.filter((c) => c.integration_id == null).map((c) => c.context);
    return unpinned.length === 0 ? pass() : fail(`required checks not pinned to an app: ${unpinned.join(', ')}`);
  },

  async 'rulesets.release-tags-locked'(ctx) {
    const matches = (await ctx.rulesets()).filter((r) => {
      const include = r.conditions?.ref_name?.include ?? [];
      return (
        r.target === 'tag' &&
        r.enforcement === 'active' &&
        (include.includes('refs/tags/v*') || include.includes('~ALL')) &&
        ['deletion', 'non_fast_forward', 'update'].every((t) => ruleTypes(r).has(t))
      );
    });
    return verdictWithBypass(matches, 'no active tag ruleset locks refs/tags/v*');
  },

  async 'files.security-policy'(ctx) {
    const tree = await ctx.tree();
    const own = ['SECURITY.md', '.github/SECURITY.md', 'docs/SECURITY.md'].find((p) => tree.has(p));
    let text;
    let source;
    if (own) {
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
      if (text === null) return fail('no SECURITY.md and no .github default');
    }
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
    const has = (re) => paths.some((p) => re.test(p));
    const expected = [];
    if (has(/(^|\/)bun\.lockb?$/)) expected.push(['bun']);
    else if (has(/(^|\/)package\.json$/)) expected.push(['npm', 'bun']);
    if (has(/(^|\/)Cargo\.toml$/)) expected.push(['cargo']);
    if (has(/(^|\/)go\.mod$/)) expected.push(['gomod']);
    if (has(/(^|\/)requirements[^/]*\.txt$/)) expected.push(['pip']);
    if (has(/(^|\/)pyproject\.toml$/)) expected.push(has(/(^|\/)uv\.lock$/) ? ['uv', 'pip'] : ['pip', 'uv']);
    if (has(/^\.github\/workflows\/[^/]+\.ya?ml$/)) expected.push(['github-actions']);
    if (expected.length === 0) return skip('nothing for Dependabot to update');
    const path = ['.github/dependabot.yml', '.github/dependabot.yaml'].find((p) => paths.includes(p));
    if (!path) return fail(`no dependabot.yml (needed for: ${expected.map((e) => e[0]).join(', ')})`);
    const text = await fileText(ctx.repo, path);
    const items = dependabotItems(text);
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
    const problems = [];
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
      : fail(raw ? `minimumReleaseAge is ${raw} (${seconds}s)` : 'no bunfig.toml with minimumReleaseAge');
  },

  async 'files.trusted-dependencies'(ctx) {
    const tree = await ctx.tree();
    if (!tree.has('bun.lock') && !tree.has('bun.lockb')) return skip('not a Bun project');
    const pkg = JSON.parse((await fileText(ctx.repo, 'package.json')) ?? '{}');
    if (Array.isArray(pkg.trustedDependencies)) {
      return pass(pkg.trustedDependencies.length === 0 ? 'empty' : pkg.trustedDependencies.join(', '));
    }
    const bunfig = tree.has('bunfig.toml') ? await fileText(ctx.repo, 'bunfig.toml') : '';
    if (/^\s*ignoreScripts\s*=\s*true/m.test(bunfig ?? '')) return pass('ignoreScripts = true');
    return fail("package.json has no trustedDependencies, so Bun's built-in allow-list runs install scripts");
  },

  async 'workflows.active'({ repo }) {
    const workflows = await paginate(`/repos/${OWNER}/${repo}/actions/workflows`);
    const off = workflows.filter((w) => w.state !== 'active').map((w) => `${w.name} (${w.state})`);
    return off.length === 0 ? pass() : fail(`disabled: ${off.join(', ')}`);
  },

  async 'workflows.frozen-installs'(ctx) {
    const problems = [];
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
    return found ? pass(found.path) : fail('no workflow audits dependencies');
  },

  async 'workflows.zizmor'({ repo }) {
    if (!args.zizmor) return skip('run with --zizmor');
    let stdout;
    try {
      ({ stdout } = await run('uvx', ['--from', ZIZMOR, 'zizmor', '--format', 'json', `${OWNER}/${repo}`], {
        env: { ...process.env, GH_TOKEN: token },
        maxBuffer: 64 * 1024 * 1024,
      }));
    } catch (error) {
      // zizmor exits non-zero when it reports findings; its JSON is still on stdout.
      if (typeof error.stdout !== 'string' || error.stdout.trim() === '') {
        if (/no inputs collected/.test(error.stderr ?? '')) return skip('no workflows');
        throw error;
      }
      stdout = error.stdout;
    }
    const findings = JSON.parse(stdout).filter((f) => f.determinations?.severity !== 'Informational');
    if (findings.length === 0) return pass();
    const counts = Object.entries(Object.groupBy(findings, (f) => f.ident)).map(([id, fs]) => `${id} x${fs.length}`);
    return fail(counts.join(', '));
  },

  async 'deps.dependabot-backlog'({ repo }) {
    const prs = await paginate(`/repos/${OWNER}/${repo}/pulls?state=open`);
    const cutoff = Date.now() - baseline.staleDependabotDays * DAY;
    const stale = prs.filter((p) => p.user?.login === 'dependabot[bot]' && Date.parse(p.created_at) < cutoff);
    return stale.length === 0
      ? pass()
      : fail(`${stale.length} Dependabot PR(s) older than ${baseline.staleDependabotDays} days: ${stale.map((p) => `#${p.number}`).join(', ')}`);
  },

  async 'deps.open-alerts'({ repo }) {
    let alerts;
    try {
      alerts = await paginate(`/repos/${OWNER}/${repo}/dependabot/alerts?state=open&severity=high,critical`);
    } catch (e) {
      // 403 with "disabled" means alerts are off (reported by its own check);
      // any other 403 is a missing permission, which must not pass silently.
      if (e instanceof ApiError && e.status === 403 && /disabled/i.test(e.message)) return skip('Dependabot alerts are off');
      throw e;
    }
    return alerts.length === 0
      ? pass()
      : fail(`${alerts.length} open high/critical alert(s): ${[...new Set(alerts.map((a) => a.dependency?.package?.name))].join(', ')}`);
  },

  async 'secrets.no-registry-tokens'({ repo }) {
    const names = (await paginate(`/repos/${OWNER}/${repo}/actions/secrets`)).map((s) => s.name);
    names.push(...(await paginate(`/repos/${OWNER}/${repo}/dependabot/secrets`)).map((s) => `dependabot/${s.name}`));
    const { body } = await api(`/repos/${OWNER}/${repo}/environments?per_page=100`);
    for (const env of body.environments ?? []) {
      const secrets = await paginate(`/repos/${OWNER}/${repo}/environments/${encodeURIComponent(env.name)}/secrets`);
      names.push(...secrets.map((s) => `${env.name}/${s.name}`));
    }
    const pattern = /NPM_TOKEN|NODE_AUTH_TOKEN|CARGO_REGISTRY_TOKEN|_PAT$|^GH_PAT|^GH_TOKEN$|TAP_TOKEN/;
    const bad = names.filter((n) => pattern.test(n.split('/').at(-1)));
    return bad.length === 0 ? pass() : fail(`secrets that look like long-lived tokens: ${bad.join(', ')}`);
  },
};

// --- Driver -----------------------------------------------------------------

// An exception is a reason string, or { reason, until: "YYYY-MM-DD" }.
function applyException(result, exception) {
  const { reason, until } = typeof exception === 'string' ? { reason: exception } : (exception ?? {});
  if (typeof reason !== 'string' || reason.trim() === '') return fail('exception has no reason');
  if (until !== undefined && !(Date.parse(until) > Date.now())) return fail(`exception expired on ${until}: ${reason}`);
  if (result.status === 'pass') return fail(`excused, but the check now passes - remove the exception (${reason})`);
  if (result.status === 'error') return result;
  return { status: 'excused', detail: until ? `${reason} (until ${until})` : reason };
}

async function checkRepo(meta) {
  const repo = meta.name;
  const entry = registry[repo];
  const results = [];
  if (!entry) {
    results.push({ repo, check: 'inventory.listed', ...fail('not in repos.json - assign a tier') });
    return results;
  }
  const ctx = context(repo, meta);
  for (const check of baseline.checks) {
    if (!check.automated || check.id === 'inventory.listed' || !appliesTo(check, entry.tier)) continue;
    const exception = entry.exceptions?.[check.id];
    let result;
    try {
      result = await CHECKS[check.id](ctx);
    } catch (e) {
      result = error(e.message);
    }
    if (exception !== undefined) result = applyException(result, exception);
    results.push({ repo, check: check.id, ...result });
  }
  for (const id of Object.keys(entry.exceptions ?? {})) {
    if (!baseline.checks.some((c) => c.id === id)) {
      results.push({ repo, check: id, ...fail('exception names an unknown check') });
    }
  }
  return results;
}

async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (i < items.length) {
      const index = i++;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

const all = (await paginate(`/users/${OWNER}/repos?type=owner`)).filter(
  (r) => !r.fork && !r.archived && r.visibility === 'public',
);
const targets = args.repo ? all.filter((r) => r.name === args.repo) : all;
if (args.repo && targets.length === 0) {
  console.error(`${OWNER}/${args.repo} is not a public, non-archived repository.`);
  process.exit(2);
}

// `/users/{owner}/repos` omits security_and_analysis; fetch each repository.
const metas = await mapLimit(targets, 6, async (r) => (await api(`/repos/${OWNER}/${r.name}`)).body);
const results = (await mapLimit(metas, 4, checkRepo)).flat();

if (!args.repo) {
  const publicNames = new Set(all.map((r) => r.name));
  for (const name of Object.keys(registry)) {
    if (!publicNames.has(name)) {
      results.push({ repo: name, check: 'inventory.listed', ...fail('listed in repos.json but not a public repository') });
    }
  }
}

// --- Report -----------------------------------------------------------------

const count = (status) => results.filter((r) => r.status === status).length;
const failing = results.filter((r) => r.status === 'fail' || r.status === 'error');
const byRepo = Object.groupBy(failing, (r) => r.repo);
const docFor = (id) => baseline.checks.find((c) => c.id === id)?.doc;

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
  for (const [repo, rows] of Object.entries(byRepo).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${repo}${registry[repo] ? ` (${registry[repo].tier})` : ''}`, '');
    for (const r of rows) {
      const doc = docFor(r.check);
      const label = doc ? `[\`${r.check}\`](https://github.com/${OWNER}/standards/blob/main/${doc})` : `\`${r.check}\``;
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
if (args.json) await writeFile(args.json, `${JSON.stringify(results, null, 2)}\n`);
if (args['fail-on-drift'] && failing.length > 0) process.exit(1);
