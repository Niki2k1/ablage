import { defineEventHandler, getRequestURL } from 'nuxt/server';
// @ts-expect-error virtual module injected by the module
import { ipxRoute } from '#ablage-image';
import { createFileResponse } from '../utils/send';
import { imageServiceURL, parseModifiers, sourceURL } from '../utils/image-service';
import { useImageService } from '../utils/image-service-runtime';
import { httpError } from '../utils/objects';
import { refFromPath } from '../utils/route-ref';

/**
 * Image route for an external service (imgproxy / standalone IPX). Same URL
 * shape as the local IPX route — `<route>/<modifiers>/<group>/<id>` — so the
 * `@nuxt/image` provider is unchanged:
 *
 * - `_` (no modifiers) serves the stored original. This is what the service
 *   fetches as its source.
 * - anything else redirects to the service, so signing keys stay server-side
 *   and this server never loads sharp/IPX.
 */
export default defineEventHandler(async (event) => {
  const url = getRequestURL(event);
  const rest = url.pathname.slice(ipxRoute.length + 1);
  const modifiers = rest.slice(0, rest.indexOf('/'));
  const ref = refFromPath(url.pathname, `${ipxRoute}/${modifiers}`);
  if (!modifiers || !ref) throw httpError(404, 'Image not found');

  if (modifiers === '_') return createFileResponse(event.req, ref);

  const config = useImageService()!;
  const location = await imageServiceURL(config, parseModifiers(modifiers), sourceURL(config, config.sourceURL ?? url.origin, ref.group, ref.id));
  return new Response(null, { status: 302, headers: { location, 'cache-control': 'public, max-age=86400' } });
});
