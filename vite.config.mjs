import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Strict CSP for the packaged app only (the dev server needs inline scripts for HMR).
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'";

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
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
  test: {
    include: ['tests/**/*.test.{js,mjs}'],
    environment: 'node',
  },
});
