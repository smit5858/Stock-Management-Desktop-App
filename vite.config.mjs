import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Strict CSP for the packaged app only (the dev server needs inline scripts for HMR).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: app-data:; media-src 'self' app-data:; font-src 'self' data:; " +
  "connect-src 'self' app-data:; object-src 'none'";

function productionCsp() {
  return {
    name: 'production-csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      ),
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), productionCsp()],
  server: {
    port: 5173,
    strictPort: true,
    // npm run dev: transform the app's modules while Electron boots, instead of one request at
    // a time when the window loads them (every page is imported at start).
      },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['tests/**/*.test.{js,mjs}'],
    environment: 'node',
  },
});
