import { imageMeta } from 'image-meta';
import { useRuntimeConfig } from 'nitropack/runtime';
// @ts-expect-error virtual module injected by the module
import { imageService, ipxRoute } from '#nuxt-filer-image';
import type {
  FileMeta,
  ImageTransformOptions,
  ImageTransformResult,
} from '../../../runtime/types';
import { useFileStorageProvider } from '../provider';
import {
  imageServiceURL,
  sourceURL,
  transformToModifiers,
  type ImageServiceConfig,
} from './image-service';

/** Group used to stage originals while the service transforms them at upload time. */
const STAGING_GROUP = '_filer-transform';

/** The configured external service, or `null` when images are processed locally. */
export function useImageService(): ImageServiceConfig | null {
  if (imageService !== 'imgproxy' && imageService !== 'ipx') return null;
  const config = (useRuntimeConfig() as { filer?: { image?: Partial<ImageServiceConfig> } }).filer?.image ?? {};
  if (!config.baseURL) {
    throw new Error(
      `[nuxt-filer] image service "${imageService}" needs a base URL: set \`filer.image.baseURL\` or NUXT_FILER_IMAGE_BASE_URL.`,
    );
  }
  return {
    ...config,
    service: imageService,
    route: ipxRoute,
    baseURL: config.baseURL.replace(/\/+$/, ''),
    sourceURL: config.sourceURL || undefined,
    key: config.key || undefined,
    salt: config.salt || undefined,
  };
}

/**
 * Upload-time transform through the external service: stage the original so
 * the service can fetch it, download the variant, then drop the staged copy.
 */
export async function transformWithService(
  config: ImageServiceConfig,
  data: Buffer | Uint8Array,
  options: ImageTransformOptions,
  meta?: FileMeta,
): Promise<ImageTransformResult> {
  if (!config.sourceURL) {
    throw new Error(
      '[nuxt-filer] upload-time transforms via an image service need `filer.image.sourceURL` (NUXT_FILER_IMAGE_SOURCE_URL): the origin the service can reach this app on.',
    );
  }
  const provider = useFileStorageProvider();
  const staged = await provider.create(STAGING_GROUP, data, {
    name: meta?.name ?? '',
    mime: meta?.mime ?? '',
    type: 'staging',
    version: 0,
  });
  try {
    const url = await imageServiceURL(
      config,
      transformToModifiers(options),
      sourceURL(config, config.sourceURL, STAGING_GROUP, staged.id),
    );
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`[nuxt-filer] image service responded ${response.status} for ${url}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const info = imageMeta(bytes);
    const mime = response.headers.get('content-type')?.split(';')[0] || `image/${info.type}`;
    return {
      data: bytes,
      mime,
      format: info.type ?? mime.replace(/^image\//, ''),
      width: info.width,
      height: info.height,
    };
  }
  finally {
    await provider.remove(STAGING_GROUP, staged.id);
  }
}
