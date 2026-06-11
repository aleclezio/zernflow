/**
 * SSRF-guarded fetch for the httpRequest flow node. Flow URLs are
 * user-authored (and can interpolate contact-controlled variables), so they
 * must never reach loopback, RFC1918, link-local, or cloud-metadata ranges.
 *
 * Policy:
 * - http/https only
 * - every hostname is resolved and EVERY address must be public
 * - redirects are followed manually (max 3 hops), re-validating every hop
 * - 10s timeout, 1 MB streamed response cap
 *
 * Honest residual: DNS rebinding between our lookup and undici's own lookup
 * is a TOCTOU window — closed at the deployment layer by the container
 * egress firewall (deploy session).
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function inCidr4(ip: number, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local / cloud metadata
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family !== 6) return true; // not an IP at all -> treat as unsafe

  const lower = address.toLowerCase();

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — apply the v4 policy.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]);

  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
  return false;
}

/** Scheme/shape validation — cheap, no DNS. */
export function assertSafeUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError(`scheme ${url.protocol} is not allowed`);
  }
  return url;
}

async function assertPublicHost(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");

  // Literal IPs (including decimal/octal v4 oddities the URL parser
  // normalizes) never hit DNS.
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new SsrfError(`address ${hostname} is private/reserved`);
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new SsrfError(`could not resolve ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new SsrfError(`no addresses for ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new SsrfError(`${hostname} resolves to private/reserved address`);
    }
  }
}

/**
 * fetch() with the SSRF policy applied to the initial URL and every redirect
 * hop. Returns the response with the body already read (capped) as text.
 */
export async function safeFetch(
  rawUrl: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
): Promise<{ status: number; bodyText: string }> {
  let url = assertSafeUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHost(url);

    const response = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      response.body?.cancel();
      if (!location) {
        return { status: response.status, bodyText: "" };
      }
      if (hop === MAX_REDIRECTS) {
        throw new SsrfError("too many redirects");
      }
      url = assertSafeUrl(new URL(location, url).toString());
      continue;
    }

    // Stream the body with a hard cap.
    const reader = response.body?.getReader();
    if (!reader) return { status: response.status, bodyText: "" };
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SsrfError("response body exceeds 1 MB cap");
      }
      chunks.push(value);
    }
    return { status: response.status, bodyText: Buffer.concat(chunks).toString("utf8") };
  }

  throw new SsrfError("too many redirects");
}
