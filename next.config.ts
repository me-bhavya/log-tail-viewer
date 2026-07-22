import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  rewrites: () => [
    {
      source: "/api/:path*",
      destination: "http://localhost:3201/api/:path*",
    },
  ],
};

export default nextConfig;