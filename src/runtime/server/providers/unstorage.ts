import { randomUUID } from 'node:crypto';
import { useStorage } from 'nitropack/runtime';
import type {
  FileStorageProvider,
  FileMeta,
  StoredFile,
} from '../../../runtime/types';

/**
 * Built-in provider that uses Nitro's useStorage() for both binary data and metadata.
 * Metadata is stored as JSON sidecar files alongside the binary data.
 * No database dependency required.
 */
export function createUnstorageProvider(
  storageName: string
): FileStorageProvider {
  function getStorage() {
    return useStorage(storageName);
  }

  function dataKey(groupId: string, id: string) {
    return `${groupId}:data:${id}`;
  }

  function metaKey(groupId: string, id: string) {
    return `${groupId}:meta:${id}`;
  }

  return {
    async create(groupId, data, meta) {
      const storage = getStorage();
      const id = randomUUID();

      await storage.setItemRaw(dataKey(groupId, id), data);

      if (meta) {
        await storage.setItem(metaKey(groupId, id), {
          ...meta,
          _createdAt: new Date().toISOString(),
          _updatedAt: new Date().toISOString(),
        });
      }

      return { id };
    },

    async get(groupId, id) {
      const storage = getStorage();
      const data = await storage.getItemRaw<Buffer>(dataKey(groupId, id));
      const metaData = await storage.getItem<
        FileMeta & { _createdAt?: string; _updatedAt?: string }
      >(metaKey(groupId, id));

      if (!data && !metaData) return null;

      return {
        id,
        groupId,
        data: data ?? undefined,
        meta: stripInternal(metaData),
        createdAt: metaData?._createdAt
          ? new Date(metaData._createdAt)
          : undefined,
        updatedAt: metaData?._updatedAt
          ? new Date(metaData._updatedAt)
          : undefined,
      };
    },

    async head(groupId, id) {
      const storage = getStorage();
      const metaData = await storage.getItem<
        FileMeta & { _createdAt?: string; _updatedAt?: string }
      >(metaKey(groupId, id));
      if (!metaData && !(await storage.hasItem(dataKey(groupId, id)))) return null;

      return {
        id,
        groupId,
        meta: stripInternal(metaData),
        createdAt: metaData?._createdAt
          ? new Date(metaData._createdAt)
          : undefined,
        updatedAt: metaData?._updatedAt
          ? new Date(metaData._updatedAt)
          : undefined,
      };
    },

    async getData(groupId, id) {
      return await getStorage().getItemRaw<Buffer>(dataKey(groupId, id));
    },

    async getMeta(id) {
      const storage = getStorage();
      const keys = await storage.getKeys();
      const key = keys.find((k) => k.endsWith(`:meta:${id}`));
      if (!key) return null;

      const metaData = await storage.getItem<FileMeta>(key);
      return metaData ? stripInternal(metaData) : null;
    },

    async list(groupId) {
      const storage = getStorage();
      const keys = await storage.getKeys(groupId);

      // Get unique file IDs by filtering meta keys (format: groupId:meta:id)
      const metaKeys = keys.filter((k) => k.includes(':meta:'));
      const files: StoredFile[] = [];

      for (const key of metaKeys) {
        const parts = key.split(':');
        const id = parts[parts.length - 1]!;

        const metaData = await storage.getItem<
          FileMeta & { _createdAt?: string; _updatedAt?: string }
        >(key);
        if (!metaData) continue;

        files.push({
          id,
          groupId,
          meta: stripInternal(metaData),
          createdAt: metaData._createdAt
            ? new Date(metaData._createdAt)
            : undefined,
          updatedAt: metaData._updatedAt
            ? new Date(metaData._updatedAt)
            : undefined,
        });
      }

      return files;
    },

    async update(id, meta) {
      const storage = getStorage();
      const keys = await storage.getKeys();
      const key = keys.find((k) => k.endsWith(`:meta:${id}`));
      if (!key) throw new Error(`File metadata not found: ${id}`);

      const existing = await storage.getItem<
        FileMeta & { _createdAt?: string; _updatedAt?: string }
      >(key);

      await storage.setItem(key, {
        ...existing,
        ...meta,
        _updatedAt: new Date().toISOString(),
      });
    },

    async remove(groupId, id) {
      const storage = getStorage();
      await storage.removeItem(dataKey(groupId, id));
      await storage.removeItem(metaKey(groupId, id));
    },

    async clear(groupId) {
      const storage = getStorage();
      const keys = await storage.getKeys(groupId);
      for (const key of keys) {
        await storage.removeItem(key);
      }
    },

    async has(groupId, id) {
      return await getStorage().hasItem(dataKey(groupId, id));
    },

    async findByMeta(filter) {
      const storage = getStorage();
      const prefix = filter.groupId ?? '';
      const keys = await storage.getKeys(prefix);
      const metaKeys = keys.filter((k) => k.includes(':meta:'));

      for (const key of metaKeys) {
        const metaData = await storage.getItem<
          FileMeta & { _createdAt?: string; _updatedAt?: string }
        >(key);
        if (!metaData) continue;

        if (metaData[filter.key] === filter.value) {
          const parts = key.split(':');
          const id = parts[parts.length - 1]!;
          const metaIdx = parts.indexOf('meta');
          const groupId = parts.slice(0, metaIdx).join(':');

          return {
            id,
            groupId,
            meta: stripInternal(metaData),
            createdAt: metaData._createdAt
              ? new Date(metaData._createdAt)
              : undefined,
            updatedAt: metaData._updatedAt
              ? new Date(metaData._updatedAt)
              : undefined,
          };
        }
      }

      return null;
    },
  };
}

function stripInternal(
  meta: (FileMeta & { _createdAt?: string; _updatedAt?: string }) | null
): FileMeta {
  if (!meta) return { name: '', mime: '', type: '', version: 0 };
  const { _createdAt, _updatedAt, ...rest } = meta;
  return rest as FileMeta;
}
