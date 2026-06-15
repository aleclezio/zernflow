/**
 * Map a connected channel to the platform's "open a DM" deep-link, used by the
 * public ref-link redirect (`/r/[slug]`). Returns null when the platform has no
 * DM deep-link or the channel has no username — the caller falls back to a
 * simple landing page in that case.
 */
export function dmUrlForChannel(platform: string, username: string | null): string | null {
  if (!username) return null;
  // username comes from the Zernio account sync (allowlisted hosts below), but
  // encode it anyway as defence-in-depth against a future looser-handle platform.
  const handle = encodeURIComponent(username);
  switch (platform) {
    case "instagram":
      return `https://ig.me/m/${handle}`;
    case "facebook":
      return `https://m.me/${handle}`;
    case "telegram":
      return `https://t.me/${handle}`;
    case "twitter":
      return `https://twitter.com/messages/compose?recipient_id=${handle}`;
    default:
      return null;
  }
}
