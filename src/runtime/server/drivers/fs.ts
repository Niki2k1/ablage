import {
  existsSync,
  promises as fsp,
  type Dirent,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Drop-in replacement for unstorage's built-in `fs-lite` driver.
 *
 * `fs-lite` creates intermediate directories via a userspace `ensuredir`
 * (recursive `existsSync` + non-recursive `mkdir`). In practice this is
 * unreliable for first-time writes to a brand-new key path — we observed
 * ENOENT on `writeFile` even though `ensuredir` should have run. The
 * kernel's atomic `mkdir(..., { recursive: true })` is much more reliable
 * across filesystems (including container-bound volumes).
 *
 * This driver mirrors the fs-lite public surface but always pre-creates
 * the parent directory tree with a single recursive `mkdir` before any
 * write, and tolerates missing files / dirs on reads.
 *
 * Implemented against unstorage's structural `Driver` contract; we avoid
 * importing `defineDriver` so this stays decoupled from a specific
 * unstorage major.
 */

const PATH_TRAVERSE_RE = /\.\.:|\.\.$/;
const DRIVER_NAME = 'ablage-fs';

export interface FsDriverOptions {
  /** Filesystem path used as the base for all keys. Required. */
  base?: string;
  /** Treat the storage as read-only; writes become no-ops. */
  readOnly?: boolean;
  /** Suppress `clear()`. */
  noClear?: boolean;
  /** Optional ignore filter applied during `getKeys`. */
  ignore?: (path: string) => boolean;
}

function driverError(message: string): Error {
  return new Error(`[ablage] [${DRIVER_NAME}] ${message}`);
}

function ignoreNotfound<T>(err: NodeJS.ErrnoException): T | null {
  if (err.code === 'ENOENT' || err.code === 'EISDIR') return null;
  throw err;
}

async function readdirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

async function readdirRecursive(
  dir: string,
  ignore: ((p: string) => boolean) | undefined,
  maxDepth: number | undefined,
): Promise<string[]> {
  if (ignore && ignore(dir)) return [];
  const entries = await readdirSafe(dir);
  const files: string[] = [];
  await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (maxDepth === undefined || maxDepth > 0) {
          const nested = await readdirRecursive(
            entryPath,
            ignore,
            maxDepth === undefined ? undefined : maxDepth - 1,
          );
          files.push(...nested.map((f) => entry.name + '/' + f));
        }
      } else if (!(ignore && ignore(entry.name))) {
        files.push(entry.name);
      }
    }),
  );
  return files;
}

export default function fsDriver(opts: FsDriverOptions = {}) {
  if (!opts.base) {
    throw driverError('Missing required option `base`.');
  }
  const base = resolve(opts.base);

  const r = (key: string) => {
    if (PATH_TRAVERSE_RE.test(key)) {
      throw driverError(
        `Invalid key: ${JSON.stringify(key)}. It should not contain .. segments`,
      );
    }
    return join(base, key.replace(/:/g, '/'));
  };

  async function write(path: string, value: string | Buffer | Uint8Array) {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, value);
  }

  return {
    name: DRIVER_NAME,
    options: opts,
    flags: { maxDepth: true },

    hasItem(key: string) {
      return existsSync(r(key));
    },
    getItem(key: string) {
      return fsp
        .readFile(r(key), 'utf8')
        .catch((err) => ignoreNotfound<string>(err));
    },
    getItemRaw(key: string) {
      return fsp
        .readFile(r(key))
        .catch((err) => ignoreNotfound<Buffer>(err));
    },
    async getMeta(key: string) {
      const stat = (await fsp.stat(r(key)).catch(() => ({}))) as Partial<Stats>;
      return {
        atime: stat.atime,
        mtime: stat.mtime,
        size: stat.size,
        birthtime: stat.birthtime,
        ctime: stat.ctime,
      };
    },
    async setItem(key: string, value: string) {
      if (opts.readOnly) return;
      await write(r(key), value);
    },
    async setItemRaw(key: string, value: Buffer | Uint8Array) {
      if (opts.readOnly) return;
      await write(r(key), value);
    },
    async removeItem(key: string) {
      if (opts.readOnly) return;
      await fsp.unlink(r(key)).catch((err) => ignoreNotfound(err));
    },
    getKeys(_base?: string, topts?: { maxDepth?: number }) {
      return readdirRecursive(r('.'), opts.ignore, topts?.maxDepth);
    },
    async clear() {
      if (opts.readOnly || opts.noClear) return;
      await fsp.rm(r('.'), { recursive: true, force: true });
    },
  };
}
