import type { Storage } from 'unstorage'

/** Root storage with an in-memory `documents` mount, standing in for Nitro's useStorage(). */
export async function createNitroStorage(): Promise<Storage> {
  const { createStorage } = await import('unstorage')
  const { default: memoryDriver } = await import('unstorage/drivers/memory')
  const storage = createStorage()
  storage.mount('documents', memoryDriver())
  return storage
}

/** The `nitropack/runtime` surface the server code uses, backed by `storage`. */
export async function nitroRuntimeMock(storage: Storage) {
  const { prefixStorage } = await import('unstorage')
  return {
    useStorage: (base?: string) => (base ? prefixStorage(storage, base) : storage),
    useRuntimeConfig: () => ({}),
  }
}
