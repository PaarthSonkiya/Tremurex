/**
 * Depth guard for captured JSON (a sibling of the body-size cap in poll.ts).
 *
 * A monitored endpoint is untrusted. Deeply nested JSON parses fine — V8's
 * JSON.parse is iterative — but then overflows the stack in the *recursive*
 * redactor (redact.ts) and diff walker (diff-engine.ts): a RangeError appears
 * around 5k array / 20k object levels. A hostile or buggy endpoint could thus
 * fault every capture. Bound the nesting at the capture boundary instead.
 *
 * The check itself is iterative by necessity — a recursive checker would hit
 * the very overflow it exists to prevent. Only containers are walked; scalars
 * are leaves and cannot add depth (and skipping them keeps the work stack to
 * the number of objects/arrays, not every value).
 */
import type { JsonValue } from '@tremurex/shared';

/** Real-world JSON is almost never deeper than ~20; this is a generous ceiling. */
export const DEFAULT_MAX_JSON_DEPTH = 100;

/** Max container-nesting depth, env-configurable and read at call time. */
export function maxJsonDepth(): number {
  const raw = process.env.TREMUREX_MAX_JSON_DEPTH;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_JSON_DEPTH;
}

/**
 * True if any object/array nests deeper than `limit` levels (root container =
 * depth 0). Iterative DFS over containers only.
 */
export function jsonDepthExceeds(value: JsonValue, limit: number): boolean {
  const stack: { node: JsonValue; depth: number }[] = [{ node: value, depth: 0 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > limit) return true;
    const { node, depth } = frame;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (child !== null && typeof child === 'object')
          stack.push({ node: child, depth: depth + 1 });
      }
    } else if (node !== null && typeof node === 'object') {
      for (const child of Object.values(node)) {
        if (child !== null && typeof child === 'object')
          stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return false;
}
