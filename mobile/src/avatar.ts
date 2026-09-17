/** Generative agent pictures — same idea as the desktop app: soft abstract art
 *  derived from a seed, so a picture is stable without storing an image. */

function seedHash(str: string) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry32(a: number) {
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function avatarSVG(seed: string) {
  const r = mulberry32(seedHash(String(seed)));
  const pick = (min: number, max: number) => min + r() * (max - min);
  const base = Math.floor(r() * 360);
  const hue = (n: number) => ((Math.round(base + n) % 360) + 360) % 360;
  const bg1 = `hsl(${base},${pick(60, 85) | 0}%,${pick(46, 60) | 0}%)`;
  const bg2 = `hsl(${hue(pick(70, 230))},${pick(58, 85) | 0}%,${pick(26, 42) | 0}%)`;

  const shape = (soft: boolean) => {
    const fill = `hsl(${hue(pick(-150, 150))},${pick(70, 98) | 0}%,${pick(45, 78) | 0}%)`;
    const op = (soft ? pick(0.45, 0.9) : pick(0.2, 0.45)).toFixed(2);
    const cx = pick(6, 94) | 0;
    const cy = pick(6, 94) | 0;
    const rad = (soft ? pick(20, 48) : pick(10, 30)) | 0;
    const kind = r();
    if (kind < 0.45) return `<circle cx="${cx}" cy="${cy}" r="${rad}" fill="${fill}" opacity="${op}"/>`;
    if (kind < 0.75)
      return `<rect x="${cx - rad}" y="${cy - rad}" width="${rad * 2}" height="${rad * 2}" rx="${(rad * 0.3) | 0}" fill="${fill}" opacity="${op}" transform="rotate(${(r() * 90) | 0} ${cx} ${cy})"/>`;
    return `<path d="M${cx} ${cy - rad} L${cx + rad} ${cy + rad} L${cx - rad} ${cy + rad} Z" fill="${fill}" opacity="${op}" transform="rotate(${(r() * 360) | 0} ${cx} ${cy})"/>`;
  };

  let soft = '';
  for (let i = 0, n = 3 + Math.floor(r() * 3); i < n; i++) soft += shape(true);
  let crisp = '';
  for (let i = 0, n = 1 + Math.floor(r() * 2); i < n; i++) crisp += shape(false);

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${bg1}"/><stop offset="1" stop-color="${bg2}"/></linearGradient>` +
    `<filter id="b" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="5"/></filter>` +
    `<filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="1.2"/></filter>` +
    `<clipPath id="c"><circle cx="50" cy="50" r="50"/></clipPath></defs>` +
    `<g clip-path="url(#c)">` +
    `<rect width="100" height="100" fill="url(#g)"/>` +
    `<g filter="url(#b)">${soft}</g><g filter="url(#s)">${crisp}</g>` +
    `</g></svg>`
  );
}

export const randomSeed = () => Math.random().toString(36).slice(2, 10);
