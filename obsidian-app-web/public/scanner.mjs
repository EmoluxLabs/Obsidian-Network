/**
 * The QR scanner: a full-screen camera view that reads a wallet's RECEIVE code.
 *
 * It is deliberately outside the app's own render tree. The app repaints #app from
 * state, and a repaint that replaced a live <video> would kill the camera mid-scan.
 * So this owns one overlay element on <body>, and removes it — and the camera — the
 * moment it is done.
 *
 * It decides nothing about what a code means. `decode` turns pixels into text and
 * `interpret` says whether that text is an acceptable recipient; this file only
 * runs the camera, shows the verdict and hands back the first acceptable one.
 * A refused code (another network's address, a bad checksum, your own address) is
 * explained on screen and scanning continues.
 *
 * The camera needs a secure context (HTTPS or localhost). Anywhere it is missing,
 * refused or absent, the same overlay offers a photo of the code instead, so the
 * feature is never a dead end.
 */

const MAX_FRAME = 640; // pixels on the long side; enough for a screen-to-camera read
const MAX_PHOTO = 1600;
const TICK_MS = 120;


/** Turn a camera error into something a person can act on. */
export function cameraMessage(error) {
  const name = error?.name ?? '';
  if (!globalThis.isSecureContext && name === 'NoSecureContext') {
    return 'The camera only works on a secure (https) page. Choose a photo of the code instead.';
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Camera permission was denied. Allow it in your browser’s site settings, or choose a photo of the code.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No camera was found on this device. Choose a photo of the code instead.';
  }
  if (name === 'NotReadableError') {
    return 'The camera is in use by another app. Close it and try again, or choose a photo of the code.';
  }
  return 'The camera could not be started. Choose a photo of the code instead.';
}

/**
 * Open the scanner. Resolves with the first acceptable result of `interpret`, or
 * `null` if the user cancels.
 *
 * @param {object}   options
 * @param {(image: {data: Uint8ClampedArray, width: number, height: number}) => Promise<string|null>} options.decode
 * @param {(text: string) => Promise<{ok: boolean, message?: string}>} options.interpret
 */
export function scan({ decode, interpret }) {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.id = 'scanner';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Scan a wallet QR code');
    root.style.cssText =
      'position:fixed;inset:0;z-index:9999;background:rgba(10,12,18,.94);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;gap:14px;color:#fff;font-family:inherit';
    root.innerHTML =
      `<b style="letter-spacing:.18em;font-size:13px">SCAN WALLET QR</b>` +
      `<div style="position:relative;width:min(86vw,360px);aspect-ratio:1;border-radius:18px;overflow:hidden;background:#000">` +
      `<video id="scanner-video" playsinline muted style="width:100%;height:100%;object-fit:cover"></video>` +
      `<div style="position:absolute;inset:16%;border:3px solid rgba(255,255,255,.85);border-radius:16px;box-shadow:0 0 0 999px rgba(0,0,0,.28)"></div></div>` +
      `<div id="scanner-status" role="status" aria-live="polite" style="font-size:13px;line-height:1.5;text-align:center;max-width:340px;min-height:40px">Starting the camera…</div>` +
      `<div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">` +
      `<button id="scanner-photo" type="button" style="height:44px;padding:0 18px;border-radius:14px;border:1px solid rgba(255,255,255,.5);background:transparent;color:#fff;font-weight:700;letter-spacing:.08em;font-size:12px;cursor:pointer">CHOOSE A PHOTO</button>` +
      `<button id="scanner-cancel" type="button" style="height:44px;padding:0 18px;border-radius:14px;border:0;background:#fff;color:#111;font-weight:700;letter-spacing:.08em;font-size:12px;cursor:pointer">CANCEL</button></div>` +
      `<input id="scanner-file" type="file" accept="image/*" style="display:none">`;
    document.body.appendChild(root);

    const $ = (id) => root.querySelector(`#${id}`);
    const video = $('scanner-video');
    const status = (message, bad = false) => {
      const el = $('scanner-status');
      if (el) {
        el.textContent = message;
        el.style.color = bad ? '#FFB4B4' : '#fff';
      }
    };

    let stream = null;
    let timer = null;
    let done = false;
    let busy = false;
    let lastRefused = '';
    let lastRefusedAt = 0;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHidden);
      stream?.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
      root.remove();
      resolve(result);
    }

    function onKey(event) {
      if (event.key === 'Escape') finish(null);
    }
    // A camera left running behind a hidden tab is a privacy bug.
    function onHidden() {
      if (document.visibilityState === 'hidden') finish(null);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHidden);
    $('scanner-cancel').addEventListener('click', () => finish(null));

    /** Run one decoded string through the verdict; true when it was accepted. */
    async function consider(text) {
      const verdict = await interpret(text);
      if (done) return true;
      if (verdict.ok) {
        status('Got it.');
        finish(verdict);
        return true;
      }
      lastRefused = text;
      lastRefusedAt = Date.now();
      status(verdict.message ?? 'That code cannot be used here.', true);
      return false;
    }

    // A photo of a code: the same decode and the same verdict as the camera.
    $('scanner-photo').addEventListener('click', () => $('scanner-file').click());
    $('scanner-file').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (!file) return;
      status('Reading the photo…');
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, MAX_PHOTO / Math.max(bitmap.width, bitmap.height));
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        const text = await decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
        if (!text) return status('No QR code was found in that photo. Try a closer, sharper one.', true);
        await consider(text);
      } catch {
        status('That file could not be read as an image.', true);
      }
    });

    async function tick() {
      if (done) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          const scale = Math.min(1, MAX_FRAME / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const text = await decode(ctx.getImageData(0, 0, canvas.width, canvas.height));
          // The same refused code in front of the camera is not re-announced every frame.
          if (text && !(text === lastRefused && Date.now() - lastRefusedAt < 2500)) await consider(text);
        } catch {
          /* a bad frame is skipped, never fatal */
        }
        busy = false;
      }
      if (!done) timer = setTimeout(tick, TICK_MS);
    }

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        const insecure = !globalThis.isSecureContext;
        return status(cameraMessage({ name: insecure ? 'NoSecureContext' : 'NotFoundError' }), true);
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (done) return stream.getTracks().forEach((t) => t.stop());
        video.srcObject = stream;
        await video.play();
        status('Point the camera at the other wallet’s RECEIVE code.');
        tick();
      } catch (error) {
        status(cameraMessage(error), true);
      }
    })();
  });
}

