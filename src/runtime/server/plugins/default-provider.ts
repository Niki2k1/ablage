import { defineNitroPlugin } from 'nitropack/runtime';
// @ts-expect-error virtual module
import { storageName } from '#ablage-options';
import { createUnstorageProvider } from '../providers/unstorage';
import { setFileStorageProvider } from '../provider';

export default defineNitroPlugin(() => {
  setFileStorageProvider(createUnstorageProvider(storageName));
});
