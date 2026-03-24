import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";
const basePath = isGitHubPages ? "/aqualens" : "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@aqualens/core", "@aqualens/react"],
  images: {
    qualities: [75, 90, 100],
    ...(isGitHubPages && { unoptimized: true }),
  },
  turbopack: {
    root: path.join(__dirname, ".."),
  },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
  ...(isGitHubPages && {
    output: "export",
    basePath,
  }),
};

export default nextConfig;
