/**
 * MCP tool-catalog diff per the CLAUDE.md §8 MCP matrix (caller-of-tool
 * semantics): anything invalidating an existing call breaks; loosening
 * (required → optional) is intentionally silent.
 *
 * v1 scope (per the matrix): tools, their top-level parameters' type sets,
 * required membership, and tool/parameter descriptions. Deeper inputSchema
 * keywords are not compared. Deterministic: sorted tools and parameters.
 */
import { createDiffEntry, schemaTypes } from '@tremurex/shared';
import type { Diff, DiffEntry, JsonSchema, JsonValue } from '@tremurex/shared';

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
}

export interface ToolCatalog {
  tools: ToolDefinition[];
}

function byName(catalog: ToolCatalog): Map<string, ToolDefinition> {
  return new Map(catalog.tools.map((t) => [t.name, t]));
}

function sortedUnion(a: Iterable<string>, b: Iterable<string>): string[] {
  return [...new Set([...a, ...b])].sort();
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((v) => b.has(v));
}

/** `after` differs from `before` only by also admitting null. */
function becameNullable(before: ReadonlySet<string>, after: ReadonlySet<string>): boolean {
  if (!after.has('null') || before.has('null')) return false;
  const afterMinusNull = new Set([...after].filter((t) => t !== 'null'));
  return setsEqual(before, afterMinusNull);
}

function compareParameter(
  toolName: string,
  param: string,
  before: { schema: JsonSchema; required: boolean },
  after: { schema: JsonSchema; required: boolean },
  entries: DiffEntry[],
): void {
  const path = ['tools', toolName, param];
  const beforeTypes = schemaTypes(before.schema);
  const afterTypes = schemaTypes(after.schema);

  if (!setsEqual(beforeTypes, afterTypes)) {
    const rule = becameNullable(beforeTypes, afterTypes)
      ? 'parameter-became-nullable'
      : 'parameter-type-changed';
    entries.push(
      createDiffEntry(rule, path, {
        before: before.schema as JsonValue,
        after: after.schema as JsonValue,
      }),
    );
    // No cascade: one entry per type-changed parameter.
    return;
  }

  if (!before.required && after.required) {
    entries.push(
      createDiffEntry('optional-parameter-became-required', path, {
        before: before.schema as JsonValue,
        after: after.schema as JsonValue,
      }),
    );
  }
  // required → optional: loosening, safe for callers — silent by design.

  const beforeDesc = before.schema.description;
  const afterDesc = after.schema.description;
  if (typeof beforeDesc !== typeof afterDesc || beforeDesc !== afterDesc) {
    entries.push(
      createDiffEntry('description-changed', [...path, 'description'], {
        before: (beforeDesc ?? null) as JsonValue,
        after: (afterDesc ?? null) as JsonValue,
      }),
    );
  }
}

function compareTool(before: ToolDefinition, after: ToolDefinition, entries: DiffEntry[]): void {
  if ((before.description ?? null) !== (after.description ?? null)) {
    entries.push(
      createDiffEntry('description-changed', ['tools', before.name, 'description'], {
        before: before.description ?? null,
        after: after.description ?? null,
      }),
    );
  }

  const beforeProps = before.inputSchema.properties ?? {};
  const afterProps = after.inputSchema.properties ?? {};
  const beforeRequired = new Set(before.inputSchema.required ?? []);
  const afterRequired = new Set(after.inputSchema.required ?? []);

  for (const param of sortedUnion(Object.keys(beforeProps), Object.keys(afterProps))) {
    const beforeSchema = beforeProps[param];
    const afterSchema = afterProps[param];
    const path = ['tools', before.name, param];

    if (beforeSchema && !afterSchema) {
      entries.push(
        createDiffEntry('tool-parameter-removed', path, { before: beforeSchema as JsonValue }),
      );
    } else if (!beforeSchema && afterSchema) {
      const rule = afterRequired.has(param)
        ? 'required-parameter-added'
        : 'optional-parameter-added';
      entries.push(createDiffEntry(rule, path, { after: afterSchema as JsonValue }));
    } else if (beforeSchema && afterSchema) {
      compareParameter(
        before.name,
        param,
        { schema: beforeSchema, required: beforeRequired.has(param) },
        { schema: afterSchema, required: afterRequired.has(param) },
        entries,
      );
    }
  }
}

export function diffCatalogs(baseline: ToolCatalog, current: ToolCatalog): Diff {
  const entries: DiffEntry[] = [];
  const before = byName(baseline);
  const after = byName(current);

  for (const name of sortedUnion(before.keys(), after.keys())) {
    const beforeTool = before.get(name);
    const afterTool = after.get(name);
    if (beforeTool && !afterTool) {
      entries.push(
        createDiffEntry('tool-removed', ['tools', name], {
          before: beforeTool as unknown as JsonValue,
        }),
      );
    } else if (!beforeTool && afterTool) {
      entries.push(
        createDiffEntry('tool-added', ['tools', name], {
          after: afterTool as unknown as JsonValue,
        }),
      );
    } else if (beforeTool && afterTool) {
      compareTool(beforeTool, afterTool, entries);
    }
  }

  return { entries };
}
