import { request } from 'undici';
import type { JsonSchema, JsonValue } from '@tremurex/shared';

/** Narrow interface so the baseline service can be tested with a fake. */
export interface SchemaInference {
  infer(samples: JsonValue[]): Promise<JsonSchema>;
}

/**
 * Client for the schema-engine sidecar (§9): POST /infer with N samples,
 * get back one merged JSON Schema (draft 2020-12). Internal service call —
 * not an external endpoint (§7.1).
 */
export function createSchemaEngineClient(baseUrl: string): SchemaInference {
  return {
    async infer(samples: JsonValue[]): Promise<JsonSchema> {
      const res = await request(`${baseUrl}/infer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ samples }),
      });
      if (res.statusCode !== 200) {
        await res.body.dump();
        throw new Error(`schema-engine /infer returned ${String(res.statusCode)}`);
      }
      const data = (await res.body.json()) as { schema: JsonSchema };
      return data.schema;
    },
  };
}
