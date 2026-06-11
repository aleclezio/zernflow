import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // next/image is only used for local assets; remote profile pictures use
    // plain <img>. No remote patterns — hostname "**" was an open image proxy.
    remotePatterns: [],
  },
};

export default nextConfig;
