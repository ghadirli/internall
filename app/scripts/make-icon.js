'use strict';

/**
 * Builds build/icon.icns from build/icon-master.png.
 *
 * The master is the supplied logo cropped to its squircle, corner-masked and
 * placed on the 1024 grid Apple's icon template uses (824 px of art, centred),
 * so it sits at the same visual size as the system icons in the Dock.
 *
 * Run with:  npm run icon
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'build');
const MASTER = path.join(OUT, 'icon-master.png');

if (!fs.existsSync(MASTER)) {
  console.error(`Missing ${MASTER} — regenerate it from the source logo first.`);
  process.exit(1);
}

const set = path.join(OUT, 'icon.iconset');
fs.rmSync(set, { recursive: true, force: true });
fs.mkdirSync(set, { recursive: true });

for (const size of [16, 32, 64, 128, 256, 512]) {
  const at1 = path.join(set, `icon_${size}x${size}.png`);
  const at2 = path.join(set, `icon_${size}x${size}@2x.png`);
  execFileSync('sips', ['-z', String(size), String(size), MASTER, '--out', at1], { stdio: 'ignore' });
  execFileSync('sips', ['-z', String(size * 2), String(size * 2), MASTER, '--out', at2], { stdio: 'ignore' });
}

execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(OUT, 'icon.icns')]);
fs.rmSync(set, { recursive: true, force: true });
fs.copyFileSync(MASTER, path.join(OUT, 'icon.png'));

console.log(`  • icon  ${(fs.statSync(path.join(OUT, 'icon.icns')).size / 1024).toFixed(0)} KB from icon-master.png`);
