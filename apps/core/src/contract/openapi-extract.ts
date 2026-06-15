/**
 * Extract a self-contained JSON Schema (draft 2020-12) from an OpenAPI document
 * for use as a contract baseline (see baseline-service / the diff engine).
 *
 * Pure and deterministic (§7.4): no network, no state. The document is supplied
 * inline by the caller — Tremurex never fetches a spec by URL (§7.1).
 *
 * Scope (documented in the README): handles the keywords the diff engine
 * consumes — type/properties/required/items/enum/anyOf — plus the common
 * OpenAPI deltas:
 *   · internal `$ref` (`#/...`) is resolved; external refs are rejected,
 *     circular refs error (a contract must be finite).
 *   · `nullable: true` (3.0) folds `null` into the type.
 *   · `allOf` of object schemas is merged (properties unioned, required unioned).
 *   · `oneOf` is treated as `anyOf` for structural diffing.
 * OpenAPI-only annotations (discriminator, xml, example, readOnly, …) are dropped.
 */
import type { JsonSchema, JsonSchemaTypeName, JsonValue } from '@tremurex/shared';

export class ContractExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractExtractionError';
  }
}

export interface OpenApiSelector {
  /** The path template, exactly as keyed in the spec, e.g. "/orders/{id}". */
  path: string;
  /** HTTP method (default "get"). */
  method?: string;
  /** Response status (default: the lowest 2xx, else "default"). */
  status?: string;
  /** Response media type (default "application/json"). */
  contentType?: string;
}

type AnyObj = Record<string, unknown>;

function isObj(v: unknown): v is AnyObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Resolve an internal JSON-pointer `$ref` ("#/components/schemas/Order"). */
function resolvePointer(doc: AnyObj, ref: string): unknown {
  if (!ref.startsWith('#/')) {
    throw new ContractExtractionError(`external/non-pointer $ref is not supported: ${ref}`);
  }
  const parts = ref
    .slice(2)
    .split('/')
    .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  let cur: unknown = doc;
  for (const part of parts) {
    if (!isObj(cur) || !(part in cur)) {
      throw new ContractExtractionError(`$ref not found: ${ref}`);
    }
    cur = cur[part];
  }
  return cur;
}

/** The lowest 2xx response key, or "default", or undefined. */
function pick2xx(responses: AnyObj): string | undefined {
  const keys = Object.keys(responses).sort();
  return keys.find((k) => /^2\d\d$/.test(k)) ?? ('default' in responses ? 'default' : undefined);
}

function applyNullable(
  type: unknown,
  nullable: unknown,
): JsonSchemaTypeName | JsonSchemaTypeName[] | undefined {
  const arr = (Array.isArray(type) ? type : [type]).filter(
    (t): t is JsonSchemaTypeName => typeof t === 'string',
  );
  if (arr.length === 0) return undefined;
  if (nullable === true && !arr.includes('null')) arr.push('null');
  return arr.length === 1 ? arr[0] : arr;
}

/** Convert one OpenAPI schema node (deref'd) to a diff-engine JSON Schema. */
function convert(node: unknown, doc: AnyObj, seen: ReadonlySet<string>): JsonSchema {
  if (!isObj(node)) {
    throw new ContractExtractionError('schema node must be an object');
  }

  if (typeof node.$ref === 'string') {
    if (seen.has(node.$ref)) {
      throw new ContractExtractionError(`circular $ref: ${node.$ref}`);
    }
    return convert(resolvePointer(doc, node.$ref), doc, new Set(seen).add(node.$ref));
  }

  if (Array.isArray(node.allOf)) {
    return mergeAllOf(node, doc, seen);
  }

  const out: JsonSchema = {};
  const type = applyNullable(node.type, node.nullable);
  if (type !== undefined) out.type = type;
  if (Array.isArray(node.enum)) out.enum = node.enum as JsonValue[];

  if (isObj(node.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [key, value] of Object.entries(node.properties)) {
      properties[key] = convert(value, doc, seen);
    }
    out.properties = properties;
  }
  if (Array.isArray(node.required)) {
    out.required = node.required.filter((r): r is string => typeof r === 'string');
  }
  if (node.items !== undefined) {
    out.items = convert(node.items, doc, seen);
  }
  const union = node.anyOf ?? node.oneOf;
  if (Array.isArray(union)) {
    out.anyOf = union.map((branch) => convert(branch, doc, seen));
  }
  return out;
}

/** Merge an `allOf` (plus sibling keywords) into one object schema. */
function mergeAllOf(node: AnyObj, doc: AnyObj, seen: ReadonlySet<string>): JsonSchema {
  const allOf = (node.allOf as unknown[]).map((s) => convert(s, doc, seen));
  // Sibling keywords alongside allOf (e.g. extra properties) are part of the merge.
  const siblings: AnyObj = { ...node };
  delete siblings.allOf;
  const members = [...allOf, convert(siblings, doc, seen)];

  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  for (const member of members) {
    if (member.properties) Object.assign(properties, member.properties);
    for (const r of member.required ?? []) required.add(r);
  }

  const merged: JsonSchema = { type: 'object' };
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required].sort();
  return merged;
}

/**
 * Pull the response-body schema identified by `selector` out of an OpenAPI 3.x
 * document and return it as a dereferenced, diff-ready JSON Schema.
 */
export function extractContract(document: unknown, selector: OpenApiSelector): JsonSchema {
  if (!isObj(document)) {
    throw new ContractExtractionError('OpenAPI document must be an object');
  }
  if (!isObj(document.paths)) {
    throw new ContractExtractionError('OpenAPI document has no "paths"');
  }
  const pathItem = document.paths[selector.path];
  if (!isObj(pathItem)) {
    throw new ContractExtractionError(`path not found: ${selector.path}`);
  }
  const method = (selector.method ?? 'get').toLowerCase();
  const operation = pathItem[method];
  if (!isObj(operation)) {
    throw new ContractExtractionError(
      `method ${method.toUpperCase()} not found on ${selector.path}`,
    );
  }
  if (!isObj(operation.responses)) {
    throw new ContractExtractionError(
      `operation ${method.toUpperCase()} ${selector.path} has no responses`,
    );
  }
  const statusKey = selector.status ?? pick2xx(operation.responses);
  if (statusKey === undefined || !isObj(operation.responses[statusKey])) {
    throw new ContractExtractionError(`response ${selector.status ?? '2xx'} not found`);
  }
  const response = operation.responses[statusKey];
  if (!isObj(response.content)) {
    throw new ContractExtractionError(
      `response ${statusKey} has no content/schema to use as a contract`,
    );
  }
  const contentType = selector.contentType ?? 'application/json';
  const media = response.content[contentType];
  if (!isObj(media) || !isObj(media.schema)) {
    throw new ContractExtractionError(
      `no schema for content type "${contentType}" on response ${statusKey}`,
    );
  }
  return convert(media.schema, document, new Set());
}
