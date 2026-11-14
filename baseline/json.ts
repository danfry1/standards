// Narrows untyped JSON (config files, GitHub API responses, tool output) into
// typed values one field at a time. A value of the wrong shape throws a
// JsonShapeError naming where it came from and which field was wrong.

export type JsonObject = { readonly [key: string]: unknown };

export class JsonShapeError extends Error {
  readonly kind = 'json-shape';
  readonly source: string;
  readonly field: string;

  constructor(source: string, field: string, expected: string, options?: ErrorOptions) {
    super(`${source}: ${field} should be ${expected}`, options);
    this.name = 'JsonShapeError';
    this.source = source;
    this.field = field;
  }
}

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class Reader {
  readonly #source: string;

  /** `source` names the document in error messages, e.g. `repos.json` or `GET /repos/x`. */
  constructor(source: string) {
    this.#source = source;
  }

  /** Parses JSON text; invalid JSON throws a JsonShapeError with the parse error as its cause. */
  parse(text: string): unknown {
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed;
    } catch (cause) {
      throw new JsonShapeError(this.#source, '(document)', 'valid JSON', { cause });
    }
  }

  fail(field: string, expected: string): never {
    throw new JsonShapeError(this.#source, field, expected);
  }

  object(value: unknown, field: string): JsonObject {
    return isObject(value) ? value : this.fail(field, 'an object');
  }

  array(value: unknown, field: string): readonly unknown[] {
    return Array.isArray(value) ? value : this.fail(field, 'an array');
  }

  string(value: unknown, field: string): string {
    return typeof value === 'string' ? value : this.fail(field, 'a string');
  }

  number(value: unknown, field: string): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : this.fail(field, 'a number');
  }

  boolean(value: unknown, field: string): boolean {
    return typeof value === 'boolean' ? value : this.fail(field, 'a boolean');
  }

  strings(value: unknown, field: string): readonly string[] {
    return this.array(value, field).map((item, i) => this.string(item, `${field}[${i}]`));
  }

  /** Each item of an array, read by `read`, with the item's index in any error. */
  items<T>(value: unknown, field: string, read: (item: unknown, field: string) => T): readonly T[] {
    return this.array(value, field).map((item, i) => read(item, `${field}[${i}]`));
  }

  /** `undefined` and `null` both mean absent. */
  optional<T>(value: unknown, read: (value: unknown) => T): T | undefined {
    return value === undefined || value === null ? undefined : read(value);
  }
}
