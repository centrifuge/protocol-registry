/**
 * JSON that round-trips integers above 2^53.
 *
 * Chainlink's `chainSelector` (e.g. 5009297550715157269) is an integer no double can hold, so a
 * plain JSON.parse corrupts it and every stringify after that publishes the corrupted value. The
 * scripts this replaces restored it by regex after the fact; here the parser keeps the literal
 * source text instead (JSON.parse source access), and JSON.stringify emits it verbatim.
 */

// JSON source text access (ES2025) is in V8 and workerd but not yet in TypeScript's lib
declare global {
  interface JSON {
    rawJSON(text: string): object;
  }
}

/** Whether JSON.parse gives revivers the source text and JSON.rawJSON exists (what parseJson uses). */
function hasJsonSourceText(): boolean {
  let hasSource = false;
  JSON.parse("1", (_key, value, context?: { source?: string }) => {
    hasSource = context?.source === "1";
    return value;
  });
  return hasSource && typeof JSON.rawJSON === "function";
}

/**
 * Throws a plain `Error` on a runtime without JSON.parse source text access, where `parseJson`
 * would round integers above 2^53 without a sign of it.
 */
export function assertJsonSourceText(): void {
  if (!hasJsonSourceText()) {
    throw new Error("parseJson needs JSON.parse source text access (ES2025)");
  }
}

export function parseJson<T = unknown>(text: string): T {
  assertJsonSourceText();
  return JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source &&
    /^-?\d+$/.test(context.source)
      ? JSON.rawJSON(context.source)
      : value,
  ) as T;
}

/** Pretty-printed with two spaces, the format every published layer has used. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
