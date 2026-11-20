import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    // SPA: everything falls back to index.html; nginx serves it under /admin.
    adapter: adapter({ pages: 'build', assets: 'build', fallback: 'index.html', strict: true }),
    paths: { base: '/admin', relative: false },
  },
  compilerOptions: { runes: true },
};
