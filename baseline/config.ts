// Reads baseline.json and repos.json into typed values. Everything outside this
// file trusts these types; a malformed file fails here, naming the bad field,
// instead of deep inside a check.

import { readFile } from 'node:fs/promises';
import { Reader } from './json.ts';

export type CheckId = string;
export type Tier = string;

export type Check = {
  readonly id: CheckId;
  readonly tiers: 'all' | readonly Tier[];
  readonly automated: boolean;
  /** A Markdown link target in this repository, e.g. `repository.md#1-...`. */
  readonly doc: string;
  readonly description: string;
};

export type Baseline = {
  readonly owner: string;
  readonly contactDomains: readonly string[];
  readonly staleDependabotDays: number;
  readonly minimumReleaseAgeSeconds: number;
  readonly tiers: readonly Tier[];
  readonly checks: readonly Check[];
};

/**
 * Why a repository is excused from a check. `reason` may be empty and `until`
 * may not be a date: those are policy problems, reported by the self-check and
 * the drift check, not shape errors.
 */
export type Exception = {
  readonly reason: string;
  readonly until: string | undefined;
};

export type RepoEntry = {
  readonly tier: Tier;
  readonly exceptions: ReadonlyMap<CheckId, Exception>;
};

/** Repository name to its entry. */
export type Registry = ReadonlyMap<string, RepoEntry>;

/** Fails with a JsonShapeError naming the field if baseline.json is malformed. */
export async function loadBaseline(url: URL): Promise<Baseline> {
  const r = new Reader('baseline.json');
  const doc = r.object(r.parse(await readFile(url, 'utf8')), '(document)');

  const checks = r.items(doc['checks'], 'checks', (raw, field): Check => {
    const c = r.object(raw, field);
    return {
      id: r.string(c['id'], `${field}.id`),
      tiers: c['tiers'] === 'all' ? 'all' : r.strings(c['tiers'], `${field}.tiers`),
      automated: r.boolean(c['automated'], `${field}.automated`),
      doc: r.string(c['doc'], `${field}.doc`),
      description: r.string(c['description'], `${field}.description`),
    };
  });

  return {
    owner: r.string(doc['owner'], 'owner'),
    contactDomains: r.strings(doc['contactDomains'], 'contactDomains'),
    staleDependabotDays: r.number(doc['staleDependabotDays'], 'staleDependabotDays'),
    minimumReleaseAgeSeconds: r.number(doc['minimumReleaseAgeSeconds'], 'minimumReleaseAgeSeconds'),
    tiers: r.strings(doc['tiers'], 'tiers'),
    checks,
  };
}

/** Fails with a JsonShapeError naming the field if repos.json is malformed. */
export async function loadRegistry(url: URL): Promise<Registry> {
  const r = new Reader('repos.json');
  const doc = r.object(r.parse(await readFile(url, 'utf8')), '(document)');
  const repos = r.object(doc['repos'], 'repos');

  // An exception is a reason string, or { "reason": "...", "until": "YYYY-MM-DD" }.
  const exception = (raw: unknown, field: string): Exception => {
    if (typeof raw === 'string') return { reason: raw, until: undefined };
    const e = r.object(raw, field);
    return {
      reason: r.optional(e['reason'], (v) => r.string(v, `${field}.reason`)) ?? '',
      until: r.optional(e['until'], (v) => r.string(v, `${field}.until`)),
    };
  };

  const registry = new Map<string, RepoEntry>();
  for (const [name, raw] of Object.entries(repos)) {
    const field = `repos.${name}`;
    const entry = r.object(raw, field);
    const exceptions = new Map<CheckId, Exception>();
    const rawExceptions = r.optional(entry['exceptions'], (v) => r.object(v, `${field}.exceptions`)) ?? {};
    for (const [id, value] of Object.entries(rawExceptions)) {
      exceptions.set(id, exception(value, `${field}.exceptions.${id}`));
    }
    registry.set(name, { tier: r.string(entry['tier'], `${field}.tier`), exceptions });
  }
  return registry;
}
