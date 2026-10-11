/** Narrows to an object with string keys. Fields remain unknown until read with a typeof or `in` check. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
