/**
 * Headless Chromium for the end-to-end test. puppeteer-core and @sparticuz/chromium are NOT dependencies of this package
 * (they are large and only a test needs them): install them anywhere and point UITEST_DIR at that directory
 * (default /tmp/uitest):   mkdir -p /tmp/uitest && cd /tmp/uitest && npm init -y && npm i puppeteer-core @sparticuz/chromium
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const dir = process.env.UITEST_DIR ?? '/tmp/uitest';
const need = createRequire(join(dir, 'noop.js'));

export async function launch({ video } = {}) {
  // Must be set BEFORE @sparticuz/chromium is imported: it decides at import whether to unpack its bundled libraries.
  process.env.AWS_EXECUTION_ENV ||= 'AWS_Lambda_nodejs22.x';
  let puppeteer;
  let chromium;
  try {
    puppeteer = (await import(pathToFileURL(need.resolve('puppeteer-core')).href)).default;
    chromium = (await import(pathToFileURL(need.resolve('@sparticuz/chromium')).href)).default;
  } catch (error) {
    console.error(`No browser libraries in ${dir}: ${error.message}\nInstall: (cd ${dir} && npm i puppeteer-core @sparticuz/chromium)`);
    process.exit(2);
  }
  const args = [...chromium.args, '--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
  if (video) args.push(`--use-file-for-fake-video-capture=${video}`);
  return puppeteer.launch({ executablePath: await chromium.executablePath(), args, headless: 'shell' });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A short video of one QR code, in the only format Chromium's fake camera reads. */
export function qrVideo(modules) {
  const W = 640;
  const H = 480;
  const S = 9;
  const Q = 4;
  const Y = Buffer.alloc(W * H, 235);
  const size = (modules.length + 2 * Q) * S;
  const ox = (W - size) >> 1;
  const oy = (H - size) >> 1;
  modules.forEach((row, r) =>
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < S; y += 1) for (let x = 0; x < S; x += 1) Y[(oy + (r + Q) * S + y) * W + ox + (c + Q) * S + x] = 16;
    }),
  );
  const chroma = Buffer.alloc((W * H) / 4, 128);
  const frames = [];
  for (let i = 0; i < 10; i += 1) frames.push(Buffer.from('FRAME\n'), Y, chroma, chroma);
  const file = join(mkdtempSync(join(tmpdir(), 'obs-qr-')), 'scan.y4m');
  writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return file;
}

// ── a PNG of a QR code, for the "upload a photo" path ────────────────────────

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

/** RGBA pixels ({data,width,height}) to a PNG file; returns its path. */
export function pngFile({ data, width, height }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  const file = join(mkdtempSync(join(tmpdir(), 'obs-png-')), 'qr.png');
  writeFileSync(file, png);
  return file;
}
