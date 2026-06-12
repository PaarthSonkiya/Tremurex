/** Any JSON value — used for schema fragments and enum members. No `any` (§10). */
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

/** Canonical dialect for all inference output and diff input (CLAUDE.md §7.3). */
export const SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

export type JsonSchemaTypeName =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  | 'null';

/**
 * The JSON Schema (draft 2020-12) subset Tremurex produces and diffs.
 * Unknown keywords are tolerated (index signature) but never `any`.
 */
export interface JsonSchema {
  $schema?: string;
  type?: JsonSchemaTypeName | JsonSchemaTypeName[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: JsonValue[];
  additionalProperties?: boolean | JsonSchema;
  [keyword: string]: unknown;
}

/**
 * Normalize a schema's type constraint to a set of type names, flattening
 * `type` arrays and one level of `anyOf` branches. Empty set = unconstrained.
 */
export function schemaTypes(schema: JsonSchema): ReadonlySet<JsonSchemaTypeName> {
  const types = new Set<JsonSchemaTypeName>();
  if (typeof schema.type === 'string') {
    types.add(schema.type);
  } else if (Array.isArray(schema.type)) {
    for (const t of schema.type) {
      types.add(t);
    }
  }
  if (schema.anyOf) {
    for (const branch of schema.anyOf) {
      for (const t of schemaTypes(branch)) {
        types.add(t);
      }
    }
  }
  return types;
}

/** Whether a schema admits null — via its type set or a null enum member. */
export function isNullable(schema: JsonSchema): boolean {
  if (schemaTypes(schema).has('null')) {
    return true;
  }
  return schema.enum?.includes(null) ?? false;
}
