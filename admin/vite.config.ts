import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    // Build-time settings (see README). Empty API URL = same origin.
    __API_URL__: JSON.stringify(process.env.PUBLIC_API_URL ?? ''),
    __CLIENT_URL__: JSON.stringify(process.env.PUBLIC_CLIENT_URL ?? ''),
  },
  server: { port: 5173 },
  preview: { port: 4173 },
});
