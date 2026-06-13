import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Serve under a sub-path (e.g. /engage on os.lygge.com) when set; unset in
  // local dev so routes stay at the root.
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || undefined,
  // Self-contained server bundle for the Docker image (deploy target:
  // single-node container behind Cloudflare).
  output: "standalone",
  images: {
    // next/image is only used for local assets; remote profile pictures use
    // plain <img>. No remote patterns — hostname "**" was an open image proxy.
    remotePatterns: [],
  },
};

export default nextConfig;
