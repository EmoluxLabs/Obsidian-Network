// Serves a built extension directory the way a browser serves an extension page — with the manifest's own CSP as a
// response header — plus the helpers every UI test uses. Test-only; not part of the extension.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';

const require = createRequire(import.meta.url);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };

export function serveExtension(dist, port) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  const csp = manifest.content_security_policy.extension_pages;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://x');
    const file = path.join(dist, path.normalize(url.pathname === '/' ? '/popup.html' : url.pathname));
    if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

export async function launch() {
  for (const p of ['/tmp/chromium', '/tmp/fonts']) rmSync(p, { recursive: true, force: true });
  process.env.AWS_EXECUTION_ENV ||= 'AWS_Lambda_nodejs22.x';
  const chromium = (await import(require.resolve('@sparticuz/chromium'))).default;
  const puppeteer = (await import(require.resolve('puppeteer-core'))).default;
  return puppeteer.launch({
    // --disable-web-security stands in for the host permission a real extension holds for the server it is
    // connected to, which lets its pages read that server's responses and send its cookie.
    args: [...chromium.args, '--disable-web-security', '--window-size=480,900'],
    executablePath: await chromium.executablePath(),
    headless: 'shell',
    defaultViewport: { width: 430, height: 800 },
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitText(page, text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, text);
}
export async function clickText(page, selector, text) {
  const ok = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t) && !e.disabled);
    if (!el) return false;
    el.click();
    return true;
  }, selector, text);
  if (!ok) throw new Error(`no enabled ${selector} containing "${text}"`);
}

// Chromium with --disable-web-security leaves the Origin header off cross-origin requests, which a real browser never does
// (it always sends `Origin: chrome-extension://<id>` or `moz-extension://<id>`, and the app server's origin policy relies
// on that). So the test adds it back, as the real browser would, to every non-GET request that leaves the page's own origin.
export async function sendOrigin(page, origin) {
  await page.setRequestInterception(true);
  // `control.block` lets a test make some URLs unreachable (a server going down) through the one interceptor.
  const control = { block: null };
  page.on('request', (request) => {
    const headers = request.headers();
    if (control.block?.(request.url())) {
      request.abort('connectionrefused');
    } else if (!request.url().startsWith(origin) && request.method() !== 'GET' && request.method() !== 'HEAD' && !headers.origin && /^https?:/.test(request.url())) {
      request.continue({ headers: { ...headers, origin } });
    } else {
      request.continue();
    }
  });
  return control;
}
