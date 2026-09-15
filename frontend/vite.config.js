import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
function offlineShell() {
  return {
    name: "versioned-offline-shell",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter((name) => /\.(js|css|woff2)$/.test(name));
      const version = createHash("sha256").update(assets.sort().join("\n")).digest("hex").slice(0, 16);
      const source = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8")
        .replace('"__VERSION__"', JSON.stringify(version))
        .replace('"__ASSETS__"', JSON.stringify(["index.html", ...assets]));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  plugins: [react(), offlineShell()],
  base: "/uro-daily-pick/",
  server: { port: 3000 },
});
