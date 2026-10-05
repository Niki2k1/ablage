import { createError } from 'h3';
import { defu } from 'defu';
import { consola } from 'consola';
import {
  Server,
  type ServerOptions,
  type DataStore,
  type Upload,
} from '@tus/server';
import { FileStore } from '@tus/file-store';
// @ts-expect-error virtual module injected by the module
import { tusRoute, tusStagingDir, tusMaxSize, tusExpiration } from '#ablage-tus';
import type { FileMeta, TusPromoteOptions } from '../../../runtime/types';
import { useFileStorage } from './storage';

export type { TusPromoteOptions };

/**
 * Everything of `ServerOptions` except `path` (owned by the module config)
 * can be customized, plus the datastore itself. Note that `useTusStaging()`
 * requires a datastore with a `read()` method (like the default FileStore).
 */
export type TusServerUserOptions = Partial<Omit<ServerOptions, 'path'>> & {
  datastore?: DataStore;
};

let userOptions: TusServerUserOptions = {};
let server: Server | undefined;
let datastore: DataStore | undefined;
let expirationTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Configure the tus server (auth via `onIncomingRequest`, `onUploadFinish`,
 * a custom datastore, ...). Must be called before the first upload request —
 * a Nitro plugin is the right place.
 */
export function setTusServerOptions(options: TusServerUserOptions) {
  if (server) {
    consola.warn(
      'ablage: setTusServerOptions() called after the tus server was created — the options are ignored. Call it from a Nitro plugin instead.'
    );
    return;
  }
  userOptions = options;
}

function useTusDatastore(): DataStore {
  if (!datastore) {
    datastore =
      userOptions.datastore
      ?? new FileStore({
        directory: tusStagingDir,
        expirationPeriodInMilliseconds:
          tusExpiration > 0 ? tusExpiration : undefined,
      });
  }
  return datastore;
}

export function useTusServer(): Server {
  if (!server) {
    const { datastore: _datastore, ...serverOptions } = userOptions;
    server = new Server({
      path: tusRoute,
      respectForwardedHeaders: true,
      maxSize: tusMaxSize > 0 ? tusMaxSize : undefined,
      datastore: useTusDatastore(),
      ...serverOptions,
    });

    if (tusExpiration > 0 && !expirationTimer) {
      const instance = server;
      expirationTimer = setInterval(
        () => instance.cleanUpExpiredUploads().catch(() => {}),
        Math.min(tusExpiration, 60 * 60 * 1000)
      );
      expirationTimer.unref?.();
    }
  }
  return server;
}

/** Guards datastore ids used in file paths against traversal. */
export function isSafeTusId(id: unknown): id is string {
  return (
    typeof id === 'string'
    && id.length > 0
    && id.length <= 255
    && !id.includes('/')
    && !id.includes('\\')
    && !id.includes('..')
  );
}

/**
 * Work with uploads staged by the tus endpoint: inspect, read, remove, or
 * `promote()` them into the regular file storage.
 */
export function useTusStaging() {
  const store = useTusDatastore();

  async function info(tusId: string): Promise<Upload | null> {
    if (!isSafeTusId(tusId)) return null;
    try {
      return await store.getUpload(tusId);
    } catch {
      return null;
    }
  }

  async function read(tusId: string): Promise<Buffer | null> {
    if (!isSafeTusId(tusId)) return null;
    const readable = store as Partial<Pick<FileStore, 'read'>>;
    if (typeof readable.read !== 'function') {
      throw new TypeError(
        'ablage: the configured tus datastore does not support read() — useTusStaging() requires a FileStore-compatible datastore'
      );
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of readable.read(tusId)) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks);
    } catch {
      return null;
    }
  }

  async function remove(tusId: string): Promise<boolean> {
    if (!isSafeTusId(tusId)) return false;
    try {
      await store.remove(tusId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Move a completed staged upload into the file storage and (by default)
   * delete the staged copy. Returns the stored file's id and resolved meta.
   */
  async function promote(
    tusId: string,
    groupId: string,
    options: TusPromoteOptions = {}
  ): Promise<{ id: string; meta: FileMeta }> {
    const upload = await info(tusId);
    if (!upload) {
      throw createError({
        statusCode: 404,
        statusMessage: `No staged tus upload found for id: ${tusId}`,
      });
    }
    if (typeof upload.size === 'number' && upload.offset !== upload.size) {
      throw createError({
        statusCode: 409,
        statusMessage: `Staged tus upload is incomplete: ${tusId} (${upload.offset}/${upload.size} bytes)`,
      });
    }

    const data = await read(tusId);
    if (!data) {
      throw createError({
        statusCode: 404,
        statusMessage: `Staged tus upload data is missing for id: ${tusId}`,
      });
    }

    const tusMeta = upload.metadata ?? {};
    const meta = defu(options.meta ?? {}, {
      name: tusMeta.filename ?? tusId,
      mime: tusMeta.filetype ?? 'application/octet-stream',
      type: '',
      version: 1,
    }) as FileMeta;

    const id = await useFileStorage().upload(groupId, data, {
      meta,
      transform: options.transform,
    });

    if (options.removeStaged !== false) {
      await remove(tusId);
    }

    return { id, meta };
  }

  return { info, read, remove, promote };
}
