'use strict';

/**
 * Produces dist/index.html: the same page with the stylesheet, the compiled
 * script and every image folded in, so it can be dropped anywhere — a static
 * host, an artifact, an email attachment — and still work with no sibling files.
 */
const fs = require('fs');
const path = require('path');

const here = __dirname;
const dist = path.join(here, 'dist');
fs.mkdirSync(dist, { recursive: true });

const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };

const dataURI = (rel) => {
  const file = path.join(here, rel);
  const ext = path.extname(file).toLowerCase();
  return `data:${mime[ext] || 'application/octet-stream'};base64,${fs.readFileSync(file).toString('base64')}`;
};

let html = fs.readFileSync(path.join(here, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(here, 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(here, 'main.js'), 'utf8');

html = html
  .replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`)
  .replace('<script src="main.js"></script>', `<script>\n${js}\n</script>`)
  .replace(/(src|href)="(img\/[^"]+)"/g, (_m, attr, rel) => `${attr}="${dataURI(rel)}"`);

// The .dmg sits next to index.html on a real host, but not in a preview, so
// `node build.js --preview` points that button at the section instead of a 404.
if (process.argv.includes('--preview')) {
  html = html.replace('href="Internall-0.1.0-universal.dmg" download', 'href="#get"');
}

const out = path.join(dist, 'index.html');
fs.writeFileSync(out, html);
console.log(`wrote ${path.relative(process.cwd(), out)} — ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
