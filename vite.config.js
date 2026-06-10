import { defineConfig } from "vite";

// Served at the domain root (https://mis-lit-reviewer.misclaw.app). The big
// data files in public/data are copied to dist/data as-is and fetched at
// runtime (split into <25 MiB chunks for Cloudflare Pages).
export default defineConfig({
  base: "/",
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
