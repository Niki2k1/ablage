import { defineEventHandler, createError, getRequestURL, sendRedirect, setResponseHeader } from 'h3';
// @ts-expect-error virtual module injected by the module
import { ipxRoute } from '#ablage-image';
import { sendStoredFile } from '../utils/send';
import { imageServiceURL, parseModifiers, sourceURL } from '../utils/image-service';
import { useImageService } from '../utils/image-service-runtime';

/**
 * Image route for an external service (imgproxy / standalone IPX). Same URL
 * shape as the local IPX route — `<route>/<modifiers>/<groupId>/<id>` — so the
 * `@nuxt/image` provider is unchanged:
 *
 * - `_` (no modifiers) serves the stored original. This is what the service
 *   fetches as its source.
 * - anything else redirects to the service, so signing keys stay server-side
 *   and this server never loads sharp/IPX.
 */
export default defineEventHandler(async (event) => {
  const path = event.path.slice(ipxRoute.length).split('?')[0]!.replace(/^\/+/, '');
  const [modifiers = '', ...segments] = path.split('/');
  const parts = segments.filter(Boolean).map(decodeURIComponent);
  if (parts.length < 2) {
    throw createError({ statusCode: 404, statusMessage: 'Image not found' });
  }
  const id = parts.pop()!;
  const groupId = parts.join('/');

  if (modifiers === '_') return sendStoredFile(event, { group: groupId, id });

  const config = useImageService()!;
  const origin = config.sourceURL ?? getRequestURL(event).origin;
  const url = await imageServiceURL(config, parseModifiers(modifiers), sourceURL(config, origin, groupId, id));
  setResponseHeader(event, 'cache-control', 'public, max-age=86400');
  return sendRedirect(event, url, 302);
});
