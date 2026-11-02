import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { defineConfig } from 'vite';

// The site's public address, used in search and sharing tags, the sitemap and llms.txt.
// When you get a domain, change this one line (or build with SITE_URL=https://... ) and rebuild.
const SITE_URL = (process.env.SITE_URL || 'http://192.9.238.244').replace(/\/$/, '');

// Fills in __SITE_URL__ in index.html and in the plain files copied from public/.
const siteUrl = () => ({
  name: 'site-url',
  transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', SITE_URL),
  closeBundle() {
    for (const f of readdirSync('dist')) {
      if (!['.html', '.txt', '.xml'].includes(extname(f))) continue;
      const p = join('dist', f);
      writeFileSync(p, readFileSync(p, 'utf8').replaceAll('__SITE_URL__', SITE_URL));
    }
  },
});

// In development run the game server too (npm start, port 8080); Vite forwards to it.
export default defineConfig({
  plugins: [siteUrl()],
  build: { target: 'esnext' },
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/api': 'http://localhost:8080',
    },
  },
});
