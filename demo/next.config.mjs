import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@aqualens/core", "@aqualens/react"],
  images: {
    qualities: [75, 90, 100],
  },
  turbopack: {
    root: path.join(__dirname, ".."),
  },
};

export default nextConfig;
