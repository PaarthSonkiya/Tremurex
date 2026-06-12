/**
 * A location inside a JSON document: object keys as strings, array indices as
 * numbers. Diff code passes segments around and only formats for display/storage.
 */
export type JsonPathSegment = string | number;

/**
 * Segment meaning "every element of this array" — diff entries about an
 * array's items schema render as `$.field[*]`. (A literal object key "*"
 * would collide; accepted tradeoff, JSON APIs don't use it in practice.)
 */
export const WILDCARD = '*';

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Render segments as a JSONPath-style string rooted at `$`.
 * Keys that are not plain identifiers (including numeric-looking strings,
 * which would otherwise be ambiguous with array indices) use quoted brackets.
 */
export function formatJsonPath(segments: readonly JsonPathSegment[]): string {
  let out = '$';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      out += `[${String(segment)}]`;
    } else if (segment === WILDCARD) {
      out += '[*]';
    } else if (PLAIN_IDENTIFIER.test(segment)) {
      out += `.${segment}`;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}
