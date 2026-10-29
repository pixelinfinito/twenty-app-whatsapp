// Twenty 2.35.0 limits application-development calls to 30 per 30 seconds.
// Its SDK uploads every file immediately without retrying that throttle.
// Preload only in CI apply/integration steps; preserve all server validation.
import { setTimeout as delay } from 'node:timers/promises';

const originalFetch = globalThis.fetch;
let uploads = Promise.resolve();
let previousUploadAt = 0;

globalThis.fetch = async (input, init) => {
  const operations = init?.body instanceof FormData
    ? init.body.get('operations')
    : null;
  const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const isAppUpload = process.env.TWENTY_API_URL &&
    new URL(url).origin === new URL(process.env.TWENTY_API_URL).origin &&
    typeof operations === 'string' && operations.includes('uploadApplicationFile');

  if (!isAppUpload) return originalFetch(input, init);

  const upload = uploads.then(async () => {
    await delay(Math.max(0, 1100 - (Date.now() - previousUploadAt)));
    previousUploadAt = Date.now();
    return originalFetch(input, init);
  });
  uploads = upload.then(() => undefined, () => undefined);
  return upload;
};
