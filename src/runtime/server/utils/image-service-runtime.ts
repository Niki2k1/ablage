import { imageMeta } from 'image-meta';
import { useRuntimeConfig } from 'nitropack/runtime';
// @ts-expect-error virtual module injected by the module
import { imageService, ipxRoute } from '#ablage-image';
import type {
  ImageTransformOptions,
  ImageTransformResult,
} from '../../../runtime/types';
import { useFileStorageProvider } from '../provider';
import { computeEtag } from './objects';
import {
  imageServiceURL,
  sourceURL,
  transformToModifiers,
  type ImageServiceConfig,
} from './image-service';

/** Group used to stage originals while the service transforms them at upload time. */
const STAGING_GROUP = '_ablage-transform';

/** The configured external service, or `null` when images are processed locally. */
export function useImageService(): ImageServiceConfig | null {
  if (imageService !== 'imgproxy' && imageService !== 'ipx') return null;
  const config = (useRuntimeConfig() as { ablage?: { image?: Partial<ImageServiceConfig> } }).ablage?.image ?? {};
  if (!config.baseURL) {
    throw new Error(
      `[ablage] image service "${imageService}" needs a base URL: set \`ablage.image.baseURL\` or NUXT_ABLAGE_IMAGE_BASE_URL.`,
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
  data: Uint8Array,
  options: ImageTransformOptions,
  contentType?: string,
): Promise<ImageTransformResult> {
  if (!config.sourceURL) {
    throw new Error(
      '[ablage] upload-time transforms via an image service need `ablage.image.sourceURL` (NUXT_ABLAGE_IMAGE_SOURCE_URL): the origin the service can reach this app on.',
    );
  }
  const provider = useFileStorageProvider();
  const now = new Date();
  const staged = {
    group: STAGING_GROUP,
    id: crypto.randomUUID(),
    size: data.length,
    contentType: contentType || 'application/octet-stream',
    etag: await computeEtag(data),
    uploadedAt: now,
    updatedAt: now,
    customMetadata: {},
  };
  await provider.write(staged, data);
  try {
    const url = await imageServiceURL(
      config,
      transformToModifiers(options),
      sourceURL(config, config.sourceURL, STAGING_GROUP, staged.id),
    );
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`[ablage] image service responded ${response.status} for ${url}`);
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
    await provider.remove([staged]);
  }
}
