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
import { ipxRoute } from '#nuxt-filer-image';
import { headStoredFile, useFileStorageProvider } from '../provider';

/**
 * Maps an IPX `id` (the path after the modifiers segment) to a `(groupId, fileId)`
 * pair as used by the file storage provider. Ids are expected as
 * `groupId/fileId` — additional `/` characters in the group id are preserved.
 */
function parseId(id: string): [string, string] | null {
  const trimmed = id.replace(/^\/+/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0 || lastSlash === trimmed.length - 1) return null;
  return [trimmed.slice(0, lastSlash), trimmed.slice(lastSlash + 1)];
}

const filerStorage: IPXStorage = {
  name: 'nuxt-filer',
  async getMeta(id) {
    const parsed = parseId(id);
    if (!parsed) return undefined;
    const [groupId, fileId] = parsed;
    // Metadata only; IPX reads the bytes through getData() when it renders.
    const file = await headStoredFile(useFileStorageProvider(), groupId, fileId);
    if (!file) return undefined;
    const mtime = file.updatedAt ?? file.createdAt ?? new Date();
    return {
      // HTTP dates have second precision; without truncating, the
      // `if-modified-since` echo is always "older" than mtime and never 304s.
      mtime: new Date(Math.floor(mtime.getTime() / 1000) * 1000),
      maxAge: 60 * 60 * 24 * 365,
    };
  },
  async getData(id) {
    const parsed = parseId(id);
    if (!parsed) return undefined;
    const [groupId, fileId] = parsed;
    const data = await useFileStorageProvider().getData(groupId, fileId);
    if (!data) return undefined;
    // IPX accepts ArrayBuffer | Buffer; pass the buffer view directly.
    return data as unknown as ArrayBuffer;
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
  const ipx = ipxModule.createIPX({ storage: filerStorage });
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
