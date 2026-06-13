import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from 'node:fs';
import path from 'node:path';

function sageManifestPlugin() {
  const manifestPath = path.resolve(__dirname, 'sage-manifest.json');

  return {
    name: 'sage-manifest-plugin',

    configureServer(server: any) {
      server.middlewares.use('/sage-manifest.json', (_req: any, res: any) => {
        const json = fs.readFileSync(manifestPath, 'utf8');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(json);
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), sageManifestPlugin()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1421,
    strictPort: true,
    host: '127.0.0.1',
    hmr: {
      protocol: "ws",
      host: '127.0.0.1',
      port: 1421,
    },
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
