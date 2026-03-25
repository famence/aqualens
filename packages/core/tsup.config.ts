import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/aqualens.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: false,
  clean: true,
  minify: process.env.NODE_ENV === "production",
  external: ["html2canvas-pro"],
});
