import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isGitHubPages = process.env.GITHUB_ACTIONS === "true";

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
  ...(isGitHubPages && {
    output: "export",
    basePath: "/aqualens",
  }),
};

export default nextConfig;
