import { resolve } from "node:path"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vitest/config"

const blocks = (path: string) => resolve(import.meta.dirname, "../../.deps/blocks", path)

export default defineConfig({
  plugins: [react()],
  root: "apps/web",
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: /^@block-editor\/model\/viewer$/,
        replacement: blocks("packages/model/dist/viewer.js"),
      },
      { find: /^@block-editor\/model$/, replacement: blocks("packages/model/dist/index.js") },
      {
        find: /^@block-editor\/prosemirror\/preset$/,
        replacement: blocks("packages/prosemirror/dist/preset.js"),
      },
      {
        find: /^@block-editor\/prosemirror$/,
        replacement: blocks("packages/prosemirror/dist/index.js"),
      },
      {
        find: /^prosemirror-model$/,
        replacement: blocks("node_modules/prosemirror-model/dist/index.js"),
      },
      {
        find: /^prosemirror-state$/,
        replacement: blocks("node_modules/prosemirror-state/dist/index.js"),
      },
      {
        find: /^prosemirror-view$/,
        replacement: blocks("node_modules/prosemirror-view/dist/index.js"),
      },
    ],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:33140",
      "/health": "http://127.0.0.1:33140",
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
