import { vi } from 'vitest'
import { createUnstorageProvider } from '../src/runtime/server/providers/unstorage'
import { runProviderSuite } from './utils/provider-suite'

const storage = await vi.hoisted(async () => (await import('./utils/nitro-mock')).createNitroStorage())
vi.mock('nitropack/runtime', async () => (await import('./utils/nitro-mock')).nitroRuntimeMock(storage))

runProviderSuite('unstorage', async () => {
  await storage.clear('documents')
  return createUnstorageProvider('documents')
})
