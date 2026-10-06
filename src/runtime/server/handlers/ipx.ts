import { defineEventHandler, getRequestURL } from 'nuxt/server';
// Namespace import: ipx 3 and 4 export different handler factories, and a named
// import of one that doesn't exist fails at module link time (crashing the
// server at boot) instead of letting us feature-detect.
import * as ipxModule from 'ipx';
import type { IPXStorage } from 'ipx';
// @ts-expect-error virtual module injected by the module
import { ipxRoute } from '#ablage-image';
import type { FileRef } from '../../../runtime/types';
import { useFileStorageProvider } from '../provider';
import { normalizeRef, streamToBytes } from '../utils/objects';

/**
 * Maps an IPX `id` (the path after the modifiers segment, `group/id`) to a
 * file ref; additional `/` characters belong to the group. `null` when the
 * path isn't a valid ref.
 */
function parseId(id: string): FileRef | null {
  const trimmed = id.replace(/^\/+/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0 || lastSlash === trimmed.length - 1) return null;
  try {
    return normalizeRef({ group: trimmed.slice(0, lastSlash), id: trimmed.slice(lastSlash + 1) });
  }
  catch {
    return null;
  }
}

const ablageStorage: IPXStorage = {
  name: 'ablage',
  async getMeta(id) {
    const ref = parseId(id);
    if (!ref) return undefined;
    // Metadata only; IPX reads the bytes through getData() when it renders.
    const file = await useFileStorageProvider().head(ref).catch(() => null);
    if (!file) return undefined;
    return {
      // HTTP dates have second precision; without truncating, the
      // `if-modified-since` echo is always "older" than mtime and never 304s.
      mtime: new Date(Math.floor(file.updatedAt.getTime() / 1000) * 1000),
      maxAge: 60 * 60 * 24 * 365,
    };
  },
  async getData(id) {
    const ref = parseId(id);
    if (!ref) return undefined;
    const body = await useFileStorageProvider().read(ref).catch(() => null);
    if (!body) return undefined;
    // IPX accepts ArrayBuffer | Buffer.
    return Buffer.from(await streamToBytes(body));
  },
};

type FetchHandler = (request: Request) => Response | Promise<Response>;

/** ipx 4: `createIPXFetchHandler`; ipx 3: `createIPXWebServer`. Both take `/<modifiers>/<id>` requests. */
function createHandler(): FetchHandler {
  const ipx = ipxModule.createIPX({ storage: ablageStorage });
  const factories = ipxModule as unknown as {
    createIPXFetchHandler?: (ipx: unknown) => FetchHandler;
    createIPXWebServer?: (ipx: unknown) => FetchHandler;
  };
  const factory = factories.createIPXFetchHandler ?? factories.createIPXWebServer;
  if (!factory) throw new Error('[ablage] unsupported ipx version (expected ipx 3 or 4)');
  return factory(ipx);
}

let _handler: FetchHandler | undefined;

export default defineEventHandler((event) => {
  // IPX expects `/<modifiers>/<group>/<id>`; strip the route prefix.
  const url = getRequestURL(event);
  url.pathname = url.pathname.slice(ipxRoute.length) || '/';
  return (_handler ??= createHandler())(new Request(url, { method: event.req.method, headers: event.req.headers }));
});
