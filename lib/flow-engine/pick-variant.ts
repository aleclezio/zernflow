/**
 * Pick one phrasing for a message-sending node. When `variations` holds one or
 * more non-blank strings, returns a random one (rotating phrasings avoids the
 * identical mass-replies that platforms spam-filter); otherwise returns the
 * base `text` unchanged (backward-compatible with nodes that have no variations).
 *
 * `rng` is injectable so the choice is deterministic in tests; defaults to
 * Math.random in production.
 */
export function pickVariant(
  text: string,
  variations: string[] | undefined,
  rng: () => number = Math.random
): string {
  const valid = (variations ?? []).filter((v) => typeof v === "string" && v.trim());
  if (valid.length === 0) return text;
  return valid[Math.floor(rng() * valid.length)];
}
