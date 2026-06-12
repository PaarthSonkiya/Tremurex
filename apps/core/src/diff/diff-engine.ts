/**
 * Semantic diff + severity classifier (CLAUDE.md §4 — the differentiator).
 *
 * Walks a locked baseline schema and a new schema, emitting located,
 * severity-classified DiffEntrys per the §8 REST matrix (plus approved
 * rule 11). Consumer-of-response semantics: additions are safe; removals
 * and shape changes break.
 *
 * Two modes, because what a schema *means* depends on how it was made:
 *  - 'capture' (default, Phase 1 hot path): `current` was inferred from ONE
 *    response, so "required" there only means "present in this response".
 *    Rules that need multi-sample knowledge are suppressed:
 *      · optional field absent        → silent (conditional absence is normal
 *        — the false-positive guard multi-sample baselining exists for)
 *      · optional-field-became-required / required-field-became-optional
 *        → silent (one sample can't establish "always")
 *  - 'baseline': both sides are merged multi-sample schemas; full matrix.
 *
 * Precision rules baked in (false BREAKING is worse than missed INFO):
 *  - type narrowing is silent (capture types ⊆ baseline types; integer
 *    satisfies number)
 *  - a node with a type change emits exactly one entry — no cascading into
 *    its children
 *  - enums compare only when BOTH sides define one (inferred schemas never
 *    do, by the no-enum-inference decision)
 *
 * Deterministic: sorted key iteration, pure function of its inputs (§7.4).
 */
import { WILDCARD, createDiffEntry, isNullable, schemaTypes } from '@tremurex/shared';
import type {
  Diff,
  DiffEntry,
  JsonPathSegment,
  JsonSchema,
  JsonSchemaTypeName,
  JsonValue,
  RestRuleId,
} from '@tremurex/shared';

export interface DiffOptions {
  mode?: 'capture' | 'baseline';
}

export function diffSchemas(
  baseline: JsonSchema,
  current: JsonSchema,
  options: DiffOptions = {},
): Diff {
  const ctx: WalkContext = { mode: options.mode ?? 'capture', entries: [] };
  walkNode(baseline, current, [], false, ctx);
  return { entries: ctx.entries };
}

interface WalkContext {
  mode: 'capture' | 'baseline';
  entries: DiffEntry[];
}

const STRUCTURAL: ReadonlySet<JsonSchemaTypeName> = new Set(['object', 'array']);

function walkNode(
  base: JsonSchema,
  cur: JsonSchema,
  segments: readonly JsonPathSegment[],
  inElement: boolean,
  ctx: WalkContext,
): void {
  const baseTypes = withoutNull(schemaTypes(base));
  const curTypes = withoutNull(schemaTypes(cur));

  // Type compatibility: every (non-null) type the capture exhibits must be
  // admitted by the baseline. Narrowing is silent.
  if (baseTypes.size > 0 && curTypes.size > 0) {
    const incompatible = [...curTypes].filter((t) => !admits(baseTypes, t));
    if (incompatible.length > 0) {
      const structural =
        incompatible.some((t) => STRUCTURAL.has(t)) ||
        [...baseTypes].some((t) => STRUCTURAL.has(t));
      const rule: RestRuleId = structural
        ? 'structure-changed'
        : inElement
          ? 'array-element-type-changed'
          : 'field-type-changed';
      pushEntry(ctx, rule, segments, base, cur);
      return; // one entry per changed node — never cascade into children
    }
  }

  if (isNullable(cur) && !isNullable(base)) {
    pushEntry(ctx, 'field-became-nullable', segments, base, cur);
  }

  compareEnums(base, cur, segments, ctx);

  const baseObj = objectShape(base);
  const curObj = objectShape(cur);
  if (baseObj && curObj) {
    compareProperties(baseObj, curObj, segments, ctx);
  }

  const baseItems = arrayShape(base)?.items;
  const curItems = arrayShape(cur)?.items;
  if (baseItems && curItems) {
    walkNode(baseItems, curItems, [...segments, WILDCARD], true, ctx);
  }
}

function compareProperties(
  base: JsonSchema,
  cur: JsonSchema,
  segments: readonly JsonPathSegment[],
  ctx: WalkContext,
): void {
  const baseProps = base.properties ?? {};
  const curProps = cur.properties ?? {};
  const baseRequired = new Set(base.required ?? []);
  const curRequired = new Set(cur.required ?? []);
  const keys = [...new Set([...Object.keys(baseProps), ...Object.keys(curProps)])].sort();

  for (const key of keys) {
    const inBase = Object.hasOwn(baseProps, key);
    const inCur = Object.hasOwn(curProps, key);
    const path = [...segments, key];

    if (inBase && !inCur) {
      if (baseRequired.has(key)) {
        pushEntry(ctx, 'required-field-removed', path, baseProps[key], undefined);
      } else if (ctx.mode === 'baseline') {
        pushEntry(ctx, 'optional-field-removed', path, baseProps[key], undefined);
      }
      // capture mode + optional: conditional absence, silent by design.
      continue;
    }
    if (!inBase && inCur) {
      pushEntry(ctx, 'field-added', path, undefined, curProps[key]);
      continue;
    }

    if (ctx.mode === 'baseline') {
      if (baseRequired.has(key) && !curRequired.has(key)) {
        pushEntry(ctx, 'required-field-became-optional', path, baseProps[key], curProps[key]);
      } else if (!baseRequired.has(key) && curRequired.has(key)) {
        pushEntry(ctx, 'optional-field-became-required', path, baseProps[key], curProps[key]);
      }
    }

    const baseChild = baseProps[key];
    const curChild = curProps[key];
    if (baseChild && curChild) {
      walkNode(baseChild, curChild, path, false, ctx);
    }
  }
}

function compareEnums(
  base: JsonSchema,
  cur: JsonSchema,
  segments: readonly JsonPathSegment[],
  ctx: WalkContext,
): void {
  // Only when BOTH sides constrain values: an inferred capture schema has no
  // enum and cannot disprove membership.
  if (!Array.isArray(base.enum) || !Array.isArray(cur.enum)) {
    return;
  }
  const key = (v: JsonValue): string => JSON.stringify(v);
  const baseSet = new Set(base.enum.map(key));
  const curSet = new Set(cur.enum.map(key));
  const removed = base.enum.filter((v) => !curSet.has(key(v)));
  const added = cur.enum.filter((v) => !baseSet.has(key(v)));

  if (removed.length > 0) {
    pushEntry(ctx, 'enum-value-removed', segments, base, cur);
  }
  if (added.length > 0) {
    pushEntry(ctx, 'enum-value-added', segments, base, cur);
  }
}

// ─── shape helpers ───────────────────────────────────────────────────────────

/** Types declared directly on the node (not via anyOf). */
function ownTypes(s: JsonSchema): ReadonlySet<JsonSchemaTypeName> {
  if (typeof s.type === 'string') return new Set([s.type]);
  if (Array.isArray(s.type)) return new Set(s.type);
  return new Set();
}

/**
 * The schema node carrying object structure, if unambiguous: the node itself,
 * or exactly one object branch of its anyOf. Ambiguous unions are skipped —
 * conservative, never guesses (precision over recall).
 */
function objectShape(s: JsonSchema): JsonSchema | null {
  if (s.properties !== undefined || ownTypes(s).has('object')) return s;
  const branches = (s.anyOf ?? []).filter(
    (b) => b.properties !== undefined || ownTypes(b).has('object'),
  );
  return branches.length === 1 ? (branches[0] ?? null) : null;
}

function arrayShape(s: JsonSchema): JsonSchema | null {
  if (s.items !== undefined || ownTypes(s).has('array')) return s;
  const branches = (s.anyOf ?? []).filter((b) => b.items !== undefined || ownTypes(b).has('array'));
  return branches.length === 1 ? (branches[0] ?? null) : null;
}

function withoutNull(types: ReadonlySet<JsonSchemaTypeName>): ReadonlySet<JsonSchemaTypeName> {
  const out = new Set(types);
  out.delete('null');
  return out;
}

/** integer is a subtype of number; otherwise exact membership. */
function admits(baseTypes: ReadonlySet<JsonSchemaTypeName>, t: JsonSchemaTypeName): boolean {
  return baseTypes.has(t) || (t === 'integer' && baseTypes.has('number'));
}

function pushEntry(
  ctx: WalkContext,
  rule: RestRuleId,
  segments: readonly JsonPathSegment[],
  before: JsonSchema | undefined,
  after: JsonSchema | undefined,
): void {
  ctx.entries.push(
    createDiffEntry(rule, segments, {
      ...(before !== undefined ? { before: asFragment(before) } : {}),
      ...(after !== undefined ? { after: asFragment(after) } : {}),
    }),
  );
}

/** JsonSchema is structurally a JsonValue; the cast just narrows the index type. */
function asFragment(schema: JsonSchema): JsonValue {
  return schema as unknown as JsonValue;
}
