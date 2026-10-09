/** Test helpers: paint a QR module grid to pixels, and read a grid back out of the displayed SVG. */

/** Paint a module grid to RGBA pixels, with the quiet zone, scaled up like a screen. */
export function rasterise(modules, scale = 6, quiet = 4, invert = false) {
  const n = modules.length + quiet * 2;
  const width = n * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          const i = (((r + quiet) * scale + y) * width + (c + quiet) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }),
  );
  if (invert) for (let i = 0; i < data.length; i += 4) data[i] = data[i + 1] = data[i + 2] = 255 - data[i];
  return { data, width, height: width };
}

/** Read the modules back out of the SVG the screen shows, not out of the encoder. */
export function modulesFromSvg(svg) {
  const [, w] = /viewBox="0 0 (\d+) \d+"/.exec(svg);
  const n = Number(w) - 8;
  const grid = Array.from({ length: n }, () => Array(n).fill(false));
  for (const [, x, y] of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) grid[Number(y) - 4][Number(x) - 4] = true;
  return grid;
}

