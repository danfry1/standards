#!/usr/bin/env node
// Heuristic, zero-dependency scanner for TypeScript "escape hatches".
// It is a FAST FIRST PASS, not a type checker — every hit must be verified in
// context (some are legitimate). Pair it with `tsc --noEmit` and human review.
//
// Usage:
//   node scan-escape-hatches.mjs [dir]            # default dir: cwd
//   node scan-escape-hatches.mjs src --json       # machine-readable output
//
// Exit code: 0 if no hits, 1 if any hits (handy in a pre-commit hook / CI).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = args.find((a) => !a.startsWith("--")) ?? ".";

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".turbo",
]);

/** Categories. `comment: true` means the pattern is itself a comment directive,
 *  so we must scan it BEFORE stripping comment-only lines. */
const RULES = [
  {
    id: "ts-suppress",
    severity: "bug",
    label: "@ts-ignore / @ts-expect-error / @ts-nocheck",
    comment: true,
    test: (line) => /@ts-(ignore|expect-error|nocheck)\b/.test(line),
  },
  {
    id: "any",
    severity: "bug",
    label: "`any` in a type position",
    // `: any`, `as any`, `<any`, `| any`, `& any`, `, any`, `(any`
    test: (line) => /(?:[:<|&,(]\s*|\bas\s+)any\b/.test(line),
  },
  {
    id: "non-null",
    severity: "bug",
    label: "non-null assertion `!`",
    // ident or `)` or `]` immediately followed by `!` then a member/end — avoids `!=`, `!x`
    test: (line) => /[\w$)\]]!(?:\.|\?\.|\[|;|,|\)|\s*$)/.test(line),
  },
  {
    id: "unsafe-as",
    severity: "gap",
    label: "type assertion `as T` (not `as const`)",
    test: (line) =>
      // ignore import/export `... as ...` rebinds
      !/^\s*(import|export)\b/.test(line) &&
      /\bas\s+(?!const\b)[A-Za-z_{[(]/.test(line),
  },
  {
    id: "enum",
    severity: "style",
    label: "`enum` declaration (prefer `as const` object + union)",
    test: (line) => /\b(?:const\s+)?enum\s+[A-Za-z_$]/.test(line),
  },
  {
    id: "json-parse",
    severity: "bug",
    label: "`JSON.parse` (result is `any` — validate to a type)",
    test: (line) => /\bJSON\.parse\s*\(/.test(line),
  },
  {
    id: "loose-record",
    severity: "gap",
    label: "`Record<string, …>` annotation (consider `as const satisfies`)",
    // Flag the loose annotation, but NOT `satisfies Record<…>` — that's the
    // recommended constraint form, not a finding.
    test: (line) =>
      /\bRecord<\s*string\s*,/.test(line) && !/\bsatisfies\s+Record</.test(line),
  },
];

const SEVERITY_ORDER = { bug: 0, gap: 1, style: 2 };

function isCommentOnly(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir — skip
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && e.name !== ".") {
      if (SKIP_DIRS.has(e.name)) continue;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(full);
    } else if (/\.(ts|tsx|mts|cts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      yield full;
    }
  }
}

const findings = [];
let scanned = 0;

const rootStat = (() => {
  try { return statSync(root); } catch { return null; }
})();
if (!rootStat) {
  console.error(`Path not found: ${root}`);
  process.exit(2);
}
const files = rootStat.isDirectory() ? walk(root) : [root];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scanned++;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const commentOnly = isCommentOnly(line);
    for (const rule of RULES) {
      if (commentOnly && !rule.comment) continue;
      if (rule.test(line)) {
        findings.push({
          file: relative(".", file) || file,
          line: i + 1,
          ruleId: rule.id,
          severity: rule.severity,
          label: rule.label,
          text: line.trim().slice(0, 200),
        });
      }
    }
  }
}

findings.sort(
  (a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line,
);

if (asJson) {
  console.log(JSON.stringify({ scanned, count: findings.length, findings }, null, 2));
  process.exit(findings.length > 0 ? 1 : 0);
}

const SEV_LABEL = { bug: "BUG", gap: "GAP", style: "STYLE" };
if (findings.length === 0) {
  console.log(`Scanned ${scanned} file(s). No escape hatches found.`);
  process.exit(0);
}

let current = "";
for (const f of findings) {
  if (f.severity !== current) {
    current = f.severity;
    console.log(`\n=== ${SEV_LABEL[f.severity]} ===`);
  }
  console.log(`${f.file}:${f.line}  [${f.ruleId}] ${f.label}`);
  console.log(`    ${f.text}`);
}

const counts = findings.reduce((acc, f) => {
  acc[f.severity] = (acc[f.severity] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `\nScanned ${scanned} file(s). ${findings.length} hit(s): ` +
    `${counts.bug ?? 0} bug, ${counts.gap ?? 0} gap, ${counts.style ?? 0} style.`,
);
console.log("Heuristic only — verify each hit in context.");
process.exit(1);
