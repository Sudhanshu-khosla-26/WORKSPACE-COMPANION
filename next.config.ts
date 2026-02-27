import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'export',
  assetPrefix: './',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  reactCompiler: true,
  turbopack: {
    // process.cwd() is guaranteed to be the project dir when `npm run dev` is called
    // This overrides Turbopack's auto-detection which picks up C:\Users\admi\package.json
    root: process.cwd(),
  },
};

export default nextConfig;
