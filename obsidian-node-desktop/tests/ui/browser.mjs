// Headless-browser helper for the UI tests. Uses puppeteer-core with @sparticuz/chromium, which are
// installed on demand and are NOT dependencies of the app (see tests/ui/README.md).
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function launch() {
  for (const p of ['/tmp/chromium', '/tmp/fonts']) rmSync(p, { recursive: true, force: true });
  process.env.AWS_EXECUTION_ENV ||= 'AWS_Lambda_nodejs22.x';
  const chromium = (await import(require.resolve('@sparticuz/chromium'))).default;
  const puppeteer = (await import(require.resolve('puppeteer-core'))).default;
  return puppeteer.launch({ args: [...chromium.args, '--window-size=1400,900'], executablePath: await chromium.executablePath(), headless: 'shell', defaultViewport: { width: 1400, height: 900 } });
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
