import {
  defineEventHandler,
  sendWebResponse,
  toWebRequest,
  useBase,
  type EventHandler,
} from 'h3';
// Namespace import: ipx 3 and 4 export different handler factories, and a named
// import of one that doesn't exist fails at module link time (crashing the
// server at boot) instead of letting us feature-detect.
import * as ipxModule from 'ipx';
import type { IPXStorage } from 'ipx';
// @ts-expect-error virtual module injected by the module
import { ipxRoute } from '#ablage-image';
import { useFileStorageProvider } from '../provider';
import { normalizeRef, streamToBytes } from '../utils/objects';
import type { FileRef } from '../../../runtime/types';

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

type IPX4 = {
  createIPXFetchHandler: (
    ipx: ReturnType<typeof ipxModule.createIPX>,
    opts?: { parseURL?: (url: string) => unknown },
  ) => (request: Request) => Response | Promise<Response>;
  parseIPXURL: (url: string) => unknown;
};
type IPX3 = {
  createIPXH3Handler: (ipx: ReturnType<typeof ipxModule.createIPX>) => EventHandler;
};

function createHandler(): EventHandler {
  const ipx = ipxModule.createIPX({ storage: ablageStorage });
  const ipx4 = ipxModule as unknown as Partial<IPX4>;

  if (ipx4.createIPXFetchHandler && ipx4.parseIPXURL) {
    // ipx 4: a fetch handler. Strip the route prefix from the URL it parses so
    // it sees `/<modifiers>/<groupId>/<fileId>`.
    const { parseIPXURL } = ipx4;
    const fetchHandler = ipx4.createIPXFetchHandler(ipx, {
      parseURL(url) {
        const parsed = new URL(url);
        parsed.pathname = parsed.pathname.slice(ipxRoute.length) || '/';
        return parseIPXURL(parsed.href);
      },
    });
    return defineEventHandler(async (event) =>
      sendWebResponse(event, await fetchHandler(toWebRequest(event))),
    );
  }

  // ipx 3: an h3 handler. `useBase` rewrites the path for the inner handler
  // (assigning `event.path` throws — it's a getter-only accessor).
  return useBase(ipxRoute, (ipxModule as unknown as IPX3).createIPXH3Handler(ipx));
}

let _handler: EventHandler | null = null;

export default defineEventHandler((event) => (_handler ??= createHandler())(event));
