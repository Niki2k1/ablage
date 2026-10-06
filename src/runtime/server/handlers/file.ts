import { defineEventHandler, deriveSecret, getRequestURL } from 'nuxt/server';
// @ts-expect-error virtual module injected by the module
import { fileRoute } from '#ablage-image';
import { createFileResponse } from '../utils/send';
import { verifyFileClaims } from '../utils/signing';
import { httpError } from '../utils/objects';
import { refFromPath } from '../utils/route-ref';
import { SIGNING_PURPOSE } from '../utils/storage';

/**
 * Serves `signedUrl()` links: `<fileRoute>/<group>/<id>?expires=…&sig=…`.
 * Only requests with a valid, unexpired signature get the file; it's cached
 * privately until the link expires.
 */
export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const ref = refFromPath(url.pathname, fileRoute);
  const expires = Number(url.searchParams.get('expires'));
  const signature = url.searchParams.get('sig') ?? '';
  const download = url.searchParams.get('download') === '1';

  const valid = !!ref && await verifyFileClaims(await deriveSecret(SIGNING_PURPOSE), { ...ref, expires, download }, signature);
  if (!valid) throw httpError(403, 'Invalid or expired file link');

  const remaining = Math.max(0, expires - Math.floor(Date.now() / 1000));
  return createFileResponse(event.req, ref!, {
    disposition: download ? 'attachment' : 'inline',
    cacheControl: `private, max-age=${remaining}`,
  });
});
