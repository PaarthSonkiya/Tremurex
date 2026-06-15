import { describe, expect, it } from 'vitest';
import { ContractExtractionError, extractContract } from './openapi-extract.js';

/** A small but representative OpenAPI 3.0 document exercising the features. */
const DOC = {
  openapi: '3.0.3',
  paths: {
    '/orders/{id}': {
      get: {
        responses: {
          '200': {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } },
          },
          '404': { content: { 'application/json': { schema: { type: 'object' } } } },
        },
      },
    },
    '/things': {
      get: {
        responses: {
          default: {
            content: {
              'application/json': { schema: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Order: {
        allOf: [
          { $ref: '#/components/schemas/Entity' },
          {
            type: 'object',
            properties: {
              total: { type: 'number' },
              note: { type: 'string', nullable: true },
              status: { type: 'string', enum: ['open', 'closed'] },
              lines: { type: 'array', items: { $ref: '#/components/schemas/Entity' } },
              payment: { oneOf: [{ type: 'object' }, { type: 'string' }] },
            },
            required: ['total'],
          },
        ],
      },
      Entity: {
        type: 'object',
        properties: { id: { type: 'integer' } },
        required: ['id'],
      },
    },
  },
};

describe('extractContract', () => {
  it('resolves $ref and merges allOf (properties + required unioned)', () => {
    const schema = extractContract(DOC, { path: '/orders/{id}', method: 'get', status: '200' });
    expect(schema.type).toBe('object');
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      'id',
      'lines',
      'note',
      'payment',
      'status',
      'total',
    ]);
    // required unions the Entity ('id') and the inline object ('total').
    expect(schema.required?.sort()).toEqual(['id', 'total']);
    // the referenced Entity is dereferenced inside the merged object.
    expect(schema.properties?.id).toEqual({ type: 'integer' });
  });

  it('folds nullable into the type', () => {
    const schema = extractContract(DOC, { path: '/orders/{id}' });
    expect(schema.properties?.note?.type).toEqual(['string', 'null']);
  });

  it('keeps enums and resolves $ref inside array items', () => {
    const schema = extractContract(DOC, { path: '/orders/{id}' });
    expect(schema.properties?.status?.enum).toEqual(['open', 'closed']);
    expect(schema.properties?.lines).toEqual({
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
    });
  });

  it('maps oneOf to anyOf', () => {
    const schema = extractContract(DOC, { path: '/orders/{id}' });
    expect(schema.properties?.payment?.anyOf).toEqual([{ type: 'object' }, { type: 'string' }]);
  });

  it('defaults method to GET and status to the lowest 2xx', () => {
    // No method/status given → GET + 200 (not the 404).
    const schema = extractContract(DOC, { path: '/orders/{id}' });
    expect(schema.type).toBe('object');
    expect(schema.required).toContain('total');
  });

  it('supports the "default" response when there is no 2xx', () => {
    const schema = extractContract(DOC, { path: '/things' });
    expect(schema).toEqual({ type: 'array', items: { type: 'string' } });
  });

  it('errors clearly on a missing path / method / response / content', () => {
    expect(() => extractContract(DOC, { path: '/nope' })).toThrow(ContractExtractionError);
    expect(() => extractContract(DOC, { path: '/orders/{id}', method: 'post' })).toThrow(
      /method POST not found/,
    );
    expect(() => extractContract(DOC, { path: '/orders/{id}', status: '500' })).toThrow(
      /response 500 not found/,
    );
    expect(() => extractContract(DOC, { path: '/orders/{id}', contentType: 'text/csv' })).toThrow(
      /no schema for content type/,
    );
  });

  it('rejects external refs and circular refs', () => {
    const external = {
      paths: {
        '/x': {
          get: {
            responses: {
              '200': { content: { 'application/json': { schema: { $ref: 'other.json#/A' } } } },
            },
          },
        },
      },
    };
    expect(() => extractContract(external, { path: '/x' })).toThrow(/external/);

    const circular = {
      paths: {
        '/x': {
          get: {
            responses: {
              '200': {
                content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } },
        },
      },
    };
    expect(() => extractContract(circular, { path: '/x' })).toThrow(/circular/);
  });

  it('rejects a non-object document', () => {
    expect(() => extractContract(null, { path: '/x' })).toThrow(/must be an object/);
    expect(() => extractContract({}, { path: '/x' })).toThrow(/no "paths"/);
  });
});
