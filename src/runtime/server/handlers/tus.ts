import {
  defineEventHandler,
  toWebRequest,
  readBody,
  setResponseStatus,
  createError,
  type H3Event,
} from 'h3';
import type { ServerOptions } from '@tus/server';
// @ts-expect-error virtual module injected by the module
import { tusRoute } from '#ablage-tus';
import { useTusServer, useTusStaging, isSafeTusId } from '../utils/tus';

type IncomingRequestHook = NonNullable<ServerOptions['onIncomingRequest']>;

/**
 * `navigator.sendBeacon` cannot speak tus (no custom methods/headers), so a
 * plain POST sub-route lets a closing page bulk-delete its staged uploads.
 * The configured `onIncomingRequest` hook guards it like any tus request.
 */
async function handleCleanupBeacon(event: H3Event) {
  const body = await readBody(event).catch(() => null);
  const tusIds: string[] = Array.isArray(body?.tusIds)
    ? body.tusIds.filter(isSafeTusId).slice(0, 100)
    : [];

  const hook = useTusServer().options.onIncomingRequest as
    | IncomingRequestHook
    | undefined;
  if (hook) {
    const request = toWebRequest(event) as Parameters<IncomingRequestHook>[0];
    for (const tusId of tusIds) {
      try {
        await hook(request, tusId);
      } catch (error) {
        const status
          = (error as { status_code?: number; statusCode?: number })
            .status_code
            ?? (error as { statusCode?: number }).statusCode
            ?? 500;
        throw createError({ statusCode: status, statusMessage: 'Cleanup rejected' });
      }
    }
  }

  const staging = useTusStaging();
  await Promise.allSettled(tusIds.map((id) => staging.remove(id)));

  setResponseStatus(event, 204);
  return null;
}

export default defineEventHandler(async (event) => {
  const pathname = event.path.split('?')[0];
  if (event.method === 'POST' && pathname === `${tusRoute}/cleanup`) {
    return handleCleanupBeacon(event);
  }

  return useTusServer().handleWeb(toWebRequest(event));
});
