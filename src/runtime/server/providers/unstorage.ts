import { useStorage } from 'nitropack/runtime';
import type { FileObject, FileStorageProvider } from '../../../runtime/types';
import {
  applyPatch,
  deserializeObject,
  rangeStream,
  serializeObject,
  type SerializedFileObject,
} from '../utils/objects';

/**
 * Built-in provider on a Nitro storage mount: bytes at `<group>:data:<id>`,
 * metadata as a JSON sidecar at `<group>:meta:<id>`. No database required.
 */
export function createUnstorageProvider(storageName: string): FileStorageProvider {
  const storage = () => useStorage(storageName);
  const dataKey = (group: string, id: string) => `${group}:data:${id}`;
  const metaKey = (group: string, id: string) => `${group}:meta:${id}`;
  // unstorage normalizes `/` to `:`, so a group's sidecars all share this prefix.
  const metaPrefix = (group: string) => `${group.replace(/\//g, ':')}:meta:`;

  const readObject = async (key: string): Promise<FileObject | null> => {
    const raw = await storage().getItem<SerializedFileObject>(key);
    return raw && typeof raw === 'object' ? deserializeObject(raw) : null;
  };

  return {
    head(ref) {
      return readObject(metaKey(ref.group, ref.id));
    },

    async read(ref, range) {
      const data = await storage().getItemRaw<Uint8Array>(dataKey(ref.group, ref.id));
      return data ? rangeStream(new Uint8Array(data), range) : null;
    },

    async write(object, data) {
      // Bytes first: a sidecar never points at bytes that weren't written.
      await storage().setItemRaw(dataKey(object.group, object.id), data);
      await storage().setItem(metaKey(object.group, object.id), serializeObject(object));
    },

    async updateMeta(ref, patch) {
      const existing = await readObject(metaKey(ref.group, ref.id));
      if (!existing) return null;
      const updated = applyPatch(existing, patch);
      await storage().setItem(metaKey(ref.group, ref.id), serializeObject(updated));
      return updated;
    },

    async remove(refs) {
      await Promise.all(refs.flatMap((ref) => [
        storage().removeItem(metaKey(ref.group, ref.id)),
        storage().removeItem(dataKey(ref.group, ref.id)),
      ]));
    },

    async list(group, { limit, cursor, prefix }) {
      const base = metaPrefix(group);
      // getKeys has no pagination; page over the sorted ids instead.
      const ids = (await storage().getKeys(base))
        .filter((key) => key.startsWith(base) && !key.slice(base.length).includes(':'))
        .map((key) => key.slice(base.length))
        .filter((id) => (!prefix || id.startsWith(prefix)) && (!cursor || id > cursor))
        .sort();
      const page = ids.slice(0, limit);
      const objects = (await Promise.all(page.map((id) => readObject(metaKey(group, id)))))
        .filter((object): object is FileObject => !!object);
      const hasMore = ids.length > limit;
      return { objects, hasMore, cursor: hasMore ? page[page.length - 1] : undefined };
    },

    async findByMeta({ key, value, group }) {
      const keys = await storage().getKeys(group ? metaPrefix(group) : undefined);
      for (const metaKeyName of keys) {
        if (!metaKeyName.includes(':meta:')) continue;
        const object = await readObject(metaKeyName);
        if (object && object.customMetadata[key] === value) return object;
      }
      return null;
    },
  };
}
