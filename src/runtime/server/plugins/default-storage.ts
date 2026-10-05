import { defineNitroPlugin, useStorage } from 'nitropack/runtime';
// @ts-expect-error virtual module
import { storageName, storagePath } from '#nuxt-filer-options';
import fsDriver from '../drivers/fs';

/**
 * Mount the default filesystem-backed storage for nuxt-filer. We mount
 * via a Nitro plugin rather than `nitroConfig.storage` so that our
 * custom fs driver is bundled with the plugin and there is no runtime
 * module resolution against the package's `dist/`. A mount the app already
 * configured under the same name (`nitro.storage`) is left alone.
 */
export default defineNitroPlugin(() => {
  const storage = useStorage();
  // Exact match only: `getMount` also returns parent mounts, e.g. Nitro's own
  // `data` for a storageName of `data:files`.
  const mounted = storage.getMount(storageName).base.replace(/:$/, '');
  if (mounted === storageName.replace(/[:/]+/g, ':').replace(/:$/, '')) return;
  storage.mount(storageName, fsDriver({ base: storagePath }));
});
