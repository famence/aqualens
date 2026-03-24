import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/aqualens-react.ts"],
  format: ["cjs", "esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom", "@aqualens/core"],
  jsx: "automatic",
});
