import { defineEventHandler, getRequestURL } from 'nuxt/server';
import type { ServerOptions } from '@tus/server';
// @ts-expect-error virtual module injected by the module
import { tusRoute } from '#ablage-tus';
import { httpError } from '../utils/objects';
import { useTusServer, useTusStaging, isSafeTusId } from '../utils/tus';

type IncomingRequestHook = NonNullable<ServerOptions['onIncomingRequest']>;

/**
 * `navigator.sendBeacon` cannot speak tus (no custom methods/headers), so a
 * plain POST sub-route lets a closing page bulk-delete its staged uploads.
 * The configured `onIncomingRequest` hook guards it like any tus request.
 */
async function handleCleanupBeacon(request: Request): Promise<Response> {
  const body = await request.clone().json().catch(() => null) as { tusIds?: unknown } | null;
  const tusIds: string[] = Array.isArray(body?.tusIds)
    ? body.tusIds.filter(isSafeTusId).slice(0, 100)
    : [];

  const hook = useTusServer().options.onIncomingRequest as IncomingRequestHook | undefined;
  if (hook) {
    for (const tusId of tusIds) {
      try {
        await hook(request as Parameters<IncomingRequestHook>[0], tusId);
      }
      catch (error) {
        const status
          = (error as { status_code?: number }).status_code
            ?? (error as { statusCode?: number }).statusCode
            ?? 500;
        throw httpError(status, 'Cleanup rejected');
      }
    }
  }

  const staging = useTusStaging();
  await Promise.allSettled(tusIds.map((id) => staging.remove(id)));
  return new Response(null, { status: 204 });
}

export default defineEventHandler((event) => {
  if (event.req.method === 'POST' && getRequestURL(event).pathname === `${tusRoute}/cleanup`) {
    return handleCleanupBeacon(event.req);
  }
  return useTusServer().handleWeb(event.req);
});
