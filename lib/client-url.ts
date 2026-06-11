/** Client-side fetch prefix. Next's router/Link handle basePath automatically;
 *  hand-written fetch("/api/...") calls do NOT — route them through this. */
export function withBasePath(path: string): string {
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}
