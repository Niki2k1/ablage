import type { FileStorageProvider } from '../../runtime/types';

let _provider: FileStorageProvider | null = null;

export function setFileStorageProvider(provider: FileStorageProvider) {
  _provider = provider;
}

export function useFileStorageProvider(): FileStorageProvider {
  if (!_provider) {
    throw new Error(
      '[ablage] No file storage provider configured. Call setFileStorageProvider() in a Nitro plugin, or set `ablage.provider` to "unstorage".'
    );
  }
  return _provider;
}
