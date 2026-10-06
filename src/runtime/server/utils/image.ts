import type {
  ImageFormat,
  ImageTransformOptions,
  ImageTransformResult,
} from '../../../runtime/types';

export type { ImageFormat, ImageTransformOptions, ImageTransformResult };

const MIME_BY_FORMAT: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  avif: 'image/avif',
  gif: 'image/gif',
};

// `sharp` is an optional peer dependency — resolve it lazily and cache the
// module so unrelated installs never pay for the native binary.
type SharpModule = typeof import('sharp').default;
let sharpModule: SharpModule | undefined;

async function loadSharp(): Promise<SharpModule> {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = (await import('sharp')).default;
  }
  catch {
    throw new Error(
      '[ablage] Image transforms require the optional peer dependency `sharp`. Install it with `npm i sharp`.'
    );
  }
  return sharpModule;
}

/**
 * Process an image buffer with sharp: resize within a box, convert format,
 * optimize, and (by default) preserve animation for multi-frame inputs. Used
 * for upload-time normalization — see `useFileStorage().upload({ transform })`.
 *
 * Requires the optional `sharp` peer dependency; throws a clear error if it is
 * not installed.
 */
export async function transformImage(
  data: Buffer | Uint8Array,
  options: ImageTransformOptions = {}
): Promise<ImageTransformResult> {
  const sharp = await loadSharp();

  const animated = options.animated ?? true;
  let pipeline = sharp(data, { animated });

  if (options.width != null || options.height != null) {
    pipeline = pipeline.resize({
      width: options.width,
      height: options.height,
      fit: options.fit ?? 'inside',
      withoutEnlargement: options.withoutEnlargement ?? true,
      background: options.background,
    });
  }

  if (options.format) {
    const formatOptions
      = options.quality != null ? { quality: options.quality } : {};
    pipeline = pipeline.toFormat(
      options.format as keyof import('sharp').FormatEnum,
      formatOptions
    );
  }

  const out = await pipeline.toBuffer({ resolveWithObject: true });
  const format = out.info.format;

  return {
    data: out.data,
    format,
    mime: MIME_BY_FORMAT[format] ?? `image/${format}`,
    width: out.info.width,
    height: out.info.height,
  };
}
