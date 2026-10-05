import type { FileStorageProvider, StoredFile } from '../../runtime/types';

let _provider: FileStorageProvider | null = null;

export function setFileStorageProvider(provider: FileStorageProvider) {
  _provider = provider;
}

export function useFileStorageProvider(): FileStorageProvider {
  if (!_provider) {
    throw new Error(
      'No file storage provider configured. Call setFileStorageProvider() in a Nitro plugin or set provider option to "unstorage" in module config.'
    );
  }
  return _provider;
}

/**
 * A file's metadata without its bytes when the provider supports `head()`;
 * otherwise `get()`, whose `data` callers can reuse instead of reading again.
 */
export async function headStoredFile(
  provider: FileStorageProvider,
  groupId: string,
  id: string
): Promise<StoredFile | null> {
  return provider.head ? provider.head(groupId, id) : provider.get(groupId, id);
}
