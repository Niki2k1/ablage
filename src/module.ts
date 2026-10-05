import {
  defineNuxtModule,
  createResolver,
  addServerImports,
  addImports,
  addServerHandler,
  hasNuxtModule,
  installModule,
} from '@nuxt/kit';
import { consola } from 'consola';
import { defu } from 'defu';

export interface FilerImageOptions {
  /**
   * Enable the @nuxt/image provider + IPX route. When `true` (the default),
   * the integration registers only if `@nuxt/image` is also installed; when
   * `false`, it is never registered. Set to `'force'` to register the routes
   * even when `@nuxt/image` cannot be detected (mainly useful for tests).
   */
  enabled?: boolean | 'force';
  /** Base path for the IPX endpoint. Default: `/_filer-ipx`. */
  route?: string;
  /** Name to register the @nuxt/image provider under. Default: `filer`. */
  providerName?: string;
}

export interface FilerTusOptions {
  /** Enable the tus endpoint + composable. Defaults to `true` when the `tus` option is an object. */
  enabled?: boolean;
  /** Base route of the tus endpoint. Default: `/_filer-tus`. */
  route?: string;
  /** Directory where in-progress uploads are staged. Default: `.data/tus`. */
  stagingDir?: string;
  /** Max upload size in bytes. Default: unlimited. */
  maxSize?: number;
  /**
   * Staged uploads older than this (ms) are expired: reported to clients via
   * `Upload-Expires` and purged periodically. Default: never expire.
   */
  expiration?: number;
}

export interface ModuleOptions {
  /** Nitro storage mount name for binary file data. Default: 'documents' */
  storageName?: string;
  /** Base path for the default fs-lite storage driver. Default: '.data/documents' */
  storagePath?: string;
  /** Provider mode. 'unstorage' uses the built-in unstorage provider. 'custom' expects you to call setFileStorageProvider() in a Nitro plugin. Default: 'unstorage' */
  provider?: 'unstorage' | 'custom';
  /** @nuxt/image integration. Set to `false` to disable, or pass an object to override defaults. */
  image?: boolean | FilerImageOptions;
  /** Resumable uploads via the tus protocol. Opt-in: pass `true` or an options object. */
  tus?: boolean | FilerTusOptions;
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-filer',
    configKey: 'filer',
  },
  defaults: {
    storageName: 'documents',
    storagePath: '.data/documents',
    provider: 'unstorage',
    image: true,
    tus: false,
  },
  async setup(options, nuxt) {
    const resolver = createResolver(import.meta.url);

    // -------------------------------------------------------
    // Server auto-imports: useFileStorage composable
    // -------------------------------------------------------
    addServerImports([
      {
        name: 'useFileStorage',
        from: resolver.resolve('./runtime/server/utils/storage'),
      },
      {
        name: 'transformImage',
        from: resolver.resolve('./runtime/server/utils/image'),
      },
      {
        name: 'sendStoredFile',
        from: resolver.resolve('./runtime/server/utils/send'),
      },
    ]);

    // -------------------------------------------------------
    // Server auto-imports: provider utilities
    // -------------------------------------------------------
    const providerSpecifier = resolver.resolve('./runtime/server/provider');
    addServerImports([
      { name: 'setFileStorageProvider', from: providerSpecifier },
      { name: 'useFileStorageProvider', from: providerSpecifier },
    ]);

    // -------------------------------------------------------
    // Server auto-imports: built-in provider factories
    // -------------------------------------------------------
    addServerImports([
      {
        name: 'createUnstorageProvider',
        from: resolver.resolve('./runtime/server/providers/unstorage'),
      },
      {
        name: 'createS3Provider',
        from: resolver.resolve('./runtime/server/providers/s3'),
      },
      {
        name: 'createS3Client',
        from: resolver.resolve('./runtime/server/providers/s3'),
      },
      {
        name: 'createDrizzleProvider',
        from: resolver.resolve('./runtime/server/providers/drizzle'),
      },
      {
        name: 'importUnstorageMetadata',
        from: resolver.resolve('./runtime/server/providers/drizzle'),
      },
    ]);

    // -------------------------------------------------------
    // Auto-imports: types (available everywhere)
    // -------------------------------------------------------
    const typesSpecifier = 'nuxt-filer/runtime/types';
    addImports([
      { name: 'FileMeta', from: typesSpecifier, type: true },
      { name: 'StoredFile', from: typesSpecifier, type: true },
      { name: 'ExternalRef', from: typesSpecifier, type: true },
      { name: 'FileStorageProvider', from: typesSpecifier, type: true },
      {
        name: 'FileStorageExternalProvider',
        from: typesSpecifier,
        type: true,
      },
      { name: 'ImageFormat', from: typesSpecifier, type: true },
      { name: 'ImageTransformOptions', from: typesSpecifier, type: true },
      { name: 'ImageTransformResult', from: typesSpecifier, type: true },
      { name: 'TusUploadState', from: typesSpecifier, type: true },
      { name: 'UseTusUploadOptions', from: typesSpecifier, type: true },
      { name: 'TusPromoteOptions', from: typesSpecifier, type: true },
    ]);

    // -------------------------------------------------------
    // tus resumable uploads (opt-in)
    // -------------------------------------------------------
    const tusOpt: FilerTusOptions =
      typeof options.tus === 'object' && options.tus !== null
        ? options.tus
        : {};
    const tusEnabled =
      options.tus === true
      || (typeof options.tus === 'object'
        && options.tus !== null
        && tusOpt.enabled !== false);
    const tusRoute = (tusOpt.route ?? '/_filer-tus').replace(/\/+$/, '');
    const tusStagingDir = tusOpt.stagingDir ?? '.data/tus';

    if (tusEnabled) {
      const tusHandler = resolver.resolve('./runtime/server/handlers/tus');
      // Both the creation root (POST/OPTIONS) and per-upload URLs
      // (HEAD/PATCH/DELETE on /:id) route into the same tus server.
      addServerHandler({ route: tusRoute, handler: tusHandler });
      addServerHandler({ route: `${tusRoute}/**`, handler: tusHandler });

      const tusUtilsSpecifier = resolver.resolve('./runtime/server/utils/tus');
      addServerImports([
        { name: 'useTusServer', from: tusUtilsSpecifier },
        { name: 'setTusServerOptions', from: tusUtilsSpecifier },
        { name: 'useTusStaging', from: tusUtilsSpecifier },
      ]);

      addImports([
        {
          name: 'useTusUpload',
          from: resolver.resolve('./runtime/composables/tus'),
        },
      ]);

      nuxt.options.runtimeConfig.public.filer = defu(
        nuxt.options.runtimeConfig.public.filer as
          | Record<string, unknown>
          | undefined,
        { tusRoute }
      );
    }

    // -------------------------------------------------------
    // @nuxt/image integration
    // -------------------------------------------------------
    const imageOpt: FilerImageOptions =
      typeof options.image === 'object' && options.image !== null
        ? options.image
        : {};
    const imageEnabled =
      options.image !== false && (imageOpt.enabled ?? true) !== false;
    const ipxRoute = (imageOpt.route ?? '/_filer-ipx').replace(/\/+$/, '');
    const providerName = imageOpt.providerName ?? 'filer';

    const shouldRegisterImage =
      imageEnabled
      && (imageOpt.enabled === 'force' || hasNuxtModule('@nuxt/image'));

    if (shouldRegisterImage) {
      addServerHandler({
        route: `${ipxRoute}/**`,
        handler: resolver.resolve('./runtime/server/handlers/ipx'),
      });

      // Inject the provider into the user's image config. @nuxt/image
      // snapshots `options.providers` during its own setup, so if it has
      // already run (i.e. was listed before nuxt-filer in `modules`) we have
      // to re-install it so the snapshot includes us. When it has not run
      // yet, mutating the options is enough — its upcoming setup will see
      // the provider naturally.
      const optionsWithImage = nuxt.options as typeof nuxt.options & {
        image?: { providers?: Record<string, unknown> };
      };
      const imageConfig = optionsWithImage.image ?? {};
      const providers = imageConfig.providers ?? {};
      providers[providerName] = {
        name: providerName,
        provider: resolver.resolve('./runtime/image/provider'),
        options: { baseURL: ipxRoute },
      };
      imageConfig.providers = providers;
      optionsWithImage.image = imageConfig;

      const imageAlreadyLoaded = (
        nuxt.options as { _installedModules?: Array<{ meta?: { name?: string } }> }
      )._installedModules?.some((m) => m.meta?.name === '@nuxt/image');
      if (imageAlreadyLoaded) {
        await installModule('@nuxt/image');
      }
    } else if (imageEnabled && options.image !== false) {
      consola.info(
        'nuxt-filer: @nuxt/image not detected — IPX integration disabled. Install `@nuxt/image` to enable optimized image variants.'
      );
    }

    // -------------------------------------------------------
    // Nitro configuration: virtual module + storage mount + provider plugin
    // -------------------------------------------------------
    nuxt.hook('nitro:config', (nitroConfig) => {
      nitroConfig.virtual = nitroConfig.virtual || {};
      nitroConfig.virtual['#nuxt-filer-options'] = [
        `export const storageName = ${JSON.stringify(options.storageName)};`,
        `export const storagePath = ${JSON.stringify(options.storagePath)};`,
      ].join('\n');
      // Always emit the image virtual; the handler is only wired when enabled.
      nitroConfig.virtual['#nuxt-filer-image'] = `export const ipxRoute = ${JSON.stringify(ipxRoute)}`;
      // Same for the tus virtual, so server imports never dangle.
      nitroConfig.virtual['#nuxt-filer-tus'] = [
        `export const tusRoute = ${JSON.stringify(tusRoute)};`,
        `export const tusStagingDir = ${JSON.stringify(tusStagingDir)};`,
        `export const tusMaxSize = ${JSON.stringify(tusOpt.maxSize ?? 0)};`,
        `export const tusExpiration = ${JSON.stringify(tusOpt.expiration ?? 0)};`,
      ].join('\n');

      // Auto-mount filesystem storage for the built-in unstorage provider, and
      // for custom providers that keep bytes in it (e.g. createDrizzleProvider
      // with `blobs: storageName`). Mounting is lazy — nothing touches disk
      // until a write. We mount via a Nitro plugin that ships our own fs driver
      // (rather than `nitroConfig.storage` with `driver: 'fsLite'`) because
      // unstorage's fs-lite relies on a userspace `ensuredir` recursion that
      // intermittently fails with ENOENT on first writes to a new key path.
      // Our driver uses the kernel's atomic `mkdir(..., { recursive: true })`.
      nitroConfig.plugins = nitroConfig.plugins || [];
      nitroConfig.plugins.push(
        resolver.resolve('./runtime/server/plugins/default-storage')
      );
      if (options.provider === 'unstorage') {
        nitroConfig.plugins.push(
          resolver.resolve('./runtime/server/plugins/default-provider')
        );
      }
    });

    consola.success('nuxt-filer ready');
  },
});
