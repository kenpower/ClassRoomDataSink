// Moves SvelteKit's inline bootstrap <script> out of build/index.html into a file, so nginx can send a
// strict `script-src 'self'` Content-Security-Policy with no hashes or 'unsafe-inline'.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = 'build/index.html';
let html = readFileSync(file, 'utf8');
let n = 0;
html = html.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g, (whole, attrs = '', body) => {
  if (/\ssrc=/.test(attrs) || !body.trim()) return whole;
  const name = `boot-${createHash('sha256').update(body).digest('hex').slice(0, 10)}.js`;
  writeFileSync(`build/_app/${name}`, body);
  n++;
  const type = /type="module"/.test(attrs) ? ' type="module"' : '';
  return `<script${type} src="/admin/_app/${name}"></script>`;
});
if (/style="/.test(html)) throw new Error('inline style attribute in index.html would violate the CSP');
writeFileSync(file, html);
console.log(`externalized ${n} inline script(s)`);
