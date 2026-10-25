#!/usr/bin/env node
// Checks this repository's own consistency, so a broken link or a bad baseline
// fails the pull request rather than the website build or the weekly run:
//
//   - every relative Markdown link points at a file that exists, and every
//     #fragment at a heading in it (GitHub's slug rules);
//   - every `doc` in baseline.json resolves the same way;
//   - repos.json only uses known tiers and names known checks in exceptions,
//     each with a reason and a valid `until` date;
//   - drift-check.mjs implements exactly the automated checks.
//
//   node baseline/self-check.mjs
//
// Zero dependencies: Node 22+ only.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, normalize } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const problems = [];

async function markdownFiles(dir) {
  const out = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!['.git', 'node_modules'].includes(entry.name)) out.push(...(await markdownFiles(path)));
    } else if (entry.name.endsWith('.md')) {
      out.push(path);
    }
  }
  return out;
}

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens,
// and -1, -2... appended to repeats. Headings inside code fences don't count.
function anchors(markdown) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = !fence && line.match(/^#{1,6}\s+(.*)$/);
    if (!heading) continue;
    const slug = heading[1].trim().toLowerCase().replace(/[^a-z0-9\s_-]/g, '').replace(/\s/g, '-');
    const n = seen.get(slug) ?? 0;
    out.add(n === 0 ? slug : `${slug}-${n}`);
    seen.set(slug, n + 1);
  }
  return out;
}

function links(markdown) {
  const out = [];
  let fence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence) continue;
    for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) out.push(m[1]);
  }
  return out;
}

const files = new Map();
for (const path of await markdownFiles('.')) files.set(normalize(path), await readFile(join(root, path), 'utf8'));

function resolve(from, target, label) {
  if (/^(https?:|mailto:)/.test(target)) return;
  const [path, fragment] = target.split('#');
  const file = path === '' ? normalize(from) : normalize(join(dirname(from), path));
  if (path !== '' && !path.endsWith('.md')) {
    if (!files.has(file)) {
      // Non-Markdown targets (baseline/*.json, workflows) only need to exist.
      return readFile(join(root, file)).catch(() => problems.push(`${label}: ${target} does not exist`));
    }
  }
  const text = files.get(file);
  if (text === undefined) return void problems.push(`${label}: ${target} does not exist`);
  if (fragment && !anchors(text).has(fragment)) problems.push(`${label}: #${fragment} is not a heading in ${file}`);
}

for (const [file, text] of files) {
  for (const target of links(text)) await resolve(file, target, file);
}

const baseline = JSON.parse(await readFile(join(root, 'baseline/baseline.json'), 'utf8'));
const { repos } = JSON.parse(await readFile(join(root, 'baseline/repos.json'), 'utf8'));
const checkIds = new Set(baseline.checks.map((c) => c.id));

if (checkIds.size !== baseline.checks.length) problems.push('baseline.json: duplicate check ids');
for (const check of baseline.checks) {
  await resolve('baseline.json', check.doc, `baseline.json ${check.id}`);
  if (check.tiers !== 'all' && !check.tiers.every((t) => baseline.tiers.includes(t))) {
    problems.push(`baseline.json ${check.id}: unknown tier in ${check.tiers.join(', ')}`);
  }
}

for (const [name, entry] of Object.entries(repos)) {
  if (!baseline.tiers.includes(entry.tier)) problems.push(`repos.json ${name}: unknown tier "${entry.tier}"`);
  for (const [id, exception] of Object.entries(entry.exceptions ?? {})) {
    if (!checkIds.has(id)) problems.push(`repos.json ${name}: exception for unknown check ${id}`);
    const { reason, until } = typeof exception === 'string' ? { reason: exception } : exception;
    if (typeof reason !== 'string' || reason.trim() === '') problems.push(`repos.json ${name} ${id}: no reason`);
    if (until !== undefined && Number.isNaN(Date.parse(until))) problems.push(`repos.json ${name} ${id}: bad until "${until}"`);
  }
}

const script = await readFile(join(root, 'baseline/drift-check.mjs'), 'utf8');
const implemented = new Set([...script.matchAll(/^ {2}async '([a-z0-9.-]+)'\(/gm)].map((m) => m[1]));
for (const check of baseline.checks) {
  if (check.automated && check.id !== 'inventory.listed' && !implemented.has(check.id)) {
    problems.push(`drift-check.mjs does not implement automated check ${check.id}`);
  }
}
for (const id of implemented) {
  if (!baseline.checks.some((c) => c.id === id && c.automated)) {
    problems.push(`drift-check.mjs implements ${id}, which baseline.json does not list as automated`);
  }
}

if (problems.length > 0) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`OK: ${files.size} Markdown files, ${baseline.checks.length} checks, ${Object.keys(repos).length} repositories.`);
