import { defu } from 'defu';
import type {
  FileMeta,
  StoredFile,
  ExternalRef,
  FileStorageProvider,
  ImageTransformOptions,
  ImageTransformResult,
} from '../../../runtime/types';
import { useFileStorageProvider } from '../provider';
import { transformImage } from './image';
import { transformWithService, useImageService } from './image-service-runtime';

export type {
  FileMeta,
  StoredFile,
  ExternalRef,
  FileStorageProvider,
  ImageTransformOptions,
  ImageTransformResult,
};

export const useFileStorage = () => {
  const provider = useFileStorageProvider();

  async function upload(
    groupId: string,
    data: Buffer | Uint8Array,
    options: { meta?: FileMeta; transform?: ImageTransformOptions } = {}
  ): Promise<string> {
    let payload = data;

    // Optional upload-time image processing, via the configured image service
    // or locally with the `sharp` peer dep. The stored bytes and the
    // metadata's mime/dimensions reflect the result.
    if (options.transform) {
      const service = useImageService();
      const result = service
        ? await transformWithService(service, data, options.transform, options.meta)
        : await transformImage(data, options.transform);
      payload = result.data;
      if (options.meta) {
        options.meta.mime = result.mime;
        options.meta.width = result.width;
        options.meta.height = result.height;
      }
    }

    const { id } = await provider.create(groupId, payload, options.meta);
    return id;
  }

  async function list(groupId: string): Promise<StoredFile[]> {
    return await provider.list(groupId);
  }

  async function get(
    groupId: string,
    id: string
  ): Promise<StoredFile | null> {
    return await provider.get(groupId, id);
  }

  async function getData(
    groupId: string,
    id: string
  ): Promise<Buffer | null> {
    return await provider.getData(groupId, id);
  }

  async function getMeta(id: string): Promise<FileMeta | null> {
    return await provider.getMeta(id);
  }

  async function updateMeta(id: string, meta: Partial<FileMeta>) {
    const existing = await provider.getMeta(id);
    const merged = defu(meta, existing) as Partial<FileMeta>;
    await provider.update(id, merged);
  }

  async function remove(groupId: string, id: string) {
    await provider.remove(groupId, id);
  }

  async function clear(groupId: string) {
    await provider.clear(groupId);
  }

  async function has(groupId: string, id: string): Promise<boolean> {
    return await provider.has(groupId, id);
  }

  async function findByMeta(
    key: string,
    value: unknown,
    groupId?: string
  ): Promise<StoredFile | null> {
    return await provider.findByMeta({ key, value, groupId });
  }

  async function checkDuplicate(
    groupId: string,
    key: string,
    value: unknown
  ): Promise<boolean> {
    const file = await provider.findByMeta({ key, value, groupId });
    return !!file;
  }

  /**
   * Get the latest version of each file (by name) within a group.
   */
  async function getLatestVersions(groupId: string): Promise<StoredFile[]> {
    const files = await list(groupId);
    const fileMap = new Map<string, StoredFile>();

    for (const file of files) {
      const existing = fileMap.get(file.meta.name);
      const version = file.meta.version ?? 0;
      const existingVersion = existing?.meta.version ?? 0;

      if (!existing || version > existingVersion) {
        fileMap.set(file.meta.name, file);
      }
    }

    return Array.from(fileMap.values());
  }

  /**
   * Determine the next version number for a file name.
   */
  function getNextVersionNumber(files: StoredFile[], name: string): number {
    const matching = files
      .filter((f) => f.meta.name === name)
      .sort((a, b) => a.meta.version - b.meta.version);

    const newest = matching[matching.length - 1];
    if (!newest) return 1;

    return newest.meta.version + 1;
  }

  // External file operations (only available if provider supports it)
  const external = provider.external
    ? {
        sync: provider.external.sync.bind(provider.external),
        push: provider.external.push.bind(provider.external),
        pull: provider.external.pull.bind(provider.external),
      }
    : undefined;

  return {
    upload,
    list,
    get,
    getData,
    getMeta,
    updateMeta,
    remove,
    clear,
    has,
    findByMeta,
    checkDuplicate,
    getLatestVersions,
    getNextVersionNumber,
    external,
  };
};
