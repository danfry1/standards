// Flat ESLint config (ESLint 9+) that mechanically enforces the rules in SKILL.md.
// Install: npm i -D eslint typescript typescript-eslint
// Then in your project's eslint.config.mjs:
//   import strict from "./skills/typescript-strict/references/eslint.config.strict.mjs";
//   export default strict;
// Requires a tsconfig that includes the linted files (type-aware linting).

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    extends: [
      // strictest preset, including rules that require type information
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // ---- Ban escape hatches ----
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // ---- Prefer the strict idioms ----
      // Disallow `enum` — use `as const` objects + union types instead.
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message:
            "Do not use `enum`. Use `as const satisfies` objects + a derived union type (see SKILL.md § No enums).",
        },
      ],
      // Force `import type` / `export type` (pairs with verbatimModuleSyntax).
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": "error",
      // `type` over `interface` for consistency (flip to "interface" if you prefer).
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      // Exhaustiveness: every discriminated-union switch must be total.
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      // `as` is the most dangerous escape hatch — allow only `as const`.
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],

      // ---- Hygiene ----
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
    },
  },
);
