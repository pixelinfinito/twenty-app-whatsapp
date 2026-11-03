// Twenty 2.35.0 limits application-development calls to 30 per 30 seconds.
// Its SDK uploads every file immediately without retrying that throttle.
// Preload only in CI apply/integration steps; preserve all server validation.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const sdkRequire = createRequire(require.resolve('twenty-sdk/cli'));
const axios = sdkRequire('axios');
const originalCreate = axios.create.bind(axios);
let uploads = Promise.resolve();
let previousUploadAt = 0;

axios.create = (...args) => {
  const client = originalCreate(...args);
  client.interceptors.request.use(async (config) => {
    const operations = config.data instanceof FormData
      ? config.data.get('operations')
      : null;
    const url = new URL(config.url, config.baseURL);
    const isAppUpload = process.env.TWENTY_API_URL &&
      url.origin === new URL(process.env.TWENTY_API_URL).origin &&
      typeof operations === 'string' && operations.includes('uploadApplicationFile');

    if (isAppUpload) {
      const slot = uploads.then(async () => {
        await delay(Math.max(0, 1100 - (Date.now() - previousUploadAt)));
        previousUploadAt = Date.now();
      });
      uploads = slot.catch(() => undefined);
      await slot;
    }
    return config;
  });
  return client;
};
