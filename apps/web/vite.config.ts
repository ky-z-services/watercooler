import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { SITE_COPY, type SiteCopyName } from './src/lib/site-copy';

/**
 * Public URL prefix, e.g. BASE_PATH=/watercooler when served at https://example.com/watercooler/
 * behind a reverse proxy that strips the prefix. Defaults to the site root.
 */
const trimmed = (process.env.BASE_PATH ?? '').replace(/^\/+|\/+$/g, '');
const base = trimmed ? `/${trimmed}/` : '/';

/** Name in the logo, footer and page title, e.g. SITE_NAME=Watercooler. */
const siteName = process.env.SITE_NAME?.trim() || 'Watercooler';

/** Which copy set from src/lib/site-copy.ts to use, e.g. SITE_COPY=neutral. */
const siteCopy = process.env.SITE_COPY?.trim() || 'watercooler';
if (!Object.hasOwn(SITE_COPY, siteCopy)) {
  throw new Error(`SITE_COPY must be one of: ${Object.keys(SITE_COPY).join(', ')} (got "${siteCopy}")`);
}

export default defineConfig({
  base,
  // import.meta.env.* defines also replace %NAME% in index.html; SITE_TAGLINE is only used there.
  define: {
    'import.meta.env.SITE_NAME': JSON.stringify(siteName),
    'import.meta.env.SITE_COPY': JSON.stringify(siteCopy),
    'import.meta.env.SITE_TAGLINE': JSON.stringify(SITE_COPY[siteCopy as SiteCopyName].tagline),
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Mirror the production proxy: strip the base path before forwarding to the API server.
      [`${base}api`]: {
        target: `http://localhost:${process.env.API_PORT ?? 3000}`,
        rewrite: (path) => path.slice(base.length - 1),
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
  },
});
