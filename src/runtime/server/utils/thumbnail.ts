import { consola } from 'consola';
import type {
  ImageTransformOptions,
  ImageTransformResult,
} from '../../../runtime/types';
import { transformImage } from './image';

export interface ThumbnailOptions extends ImageTransformOptions {
  /** PDF page to render. Default: `1`. */
  page?: number;
}

const DEFAULTS: ThumbnailOptions = {
  width: 300,
  height: 300,
  fit: 'inside',
  format: 'webp',
  // A thumbnail shows the first frame; pass `animated: true` to keep animation.
  animated: false,
};

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  consola.warn(message);
}

/** Whether an import failed because the package isn't installed (also when wrapped in `cause`). */
function isMissingModule(error: unknown): boolean {
  for (let e = error as { code?: string; message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND') return true;
    if (/Cannot find (?:module|package)|Failed to load url/i.test(String(e.message))) return true;
  }
  return false;
}

/** Render one PDF page to a PNG with `unpdf` (+ `@napi-rs/canvas` on Node). */
async function renderPdfPage(data: Uint8Array, page: number, width: number): Promise<Buffer> {
  const { renderPageAsImage } = await import('unpdf');
  // pdf.js may transfer (detach) the buffer it's given; hand it a copy so the
  // caller's bytes stay intact.
  const png = await renderPageAsImage(new Uint8Array(data), page, {
    canvasImport: () => import('@napi-rs/canvas'),
    width,
  });
  return Buffer.from(png);
}

/**
 * Generate a preview image for a stored file: images are resized with sharp,
 * PDFs have a page (default: the first) rendered with `unpdf` and then resized.
 *
 * Returns `null` — never throws — when the type isn't supported, the input
 * can't be decoded, or the optional dependencies aren't installed (`sharp`,
 * plus `unpdf` and `@napi-rs/canvas` for PDFs; a warning is logged once).
 *
 * ```ts
 * const thumb = await generateThumbnail(file.data, file.type, { width: 300, height: 200 })
 * if (thumb) await storage.put(group, thumb.data, { contentType: thumb.mime, name: `thumb_${file.name}` })
 * ```
 */
export async function generateThumbnail(
  data: Buffer | Uint8Array,
  mime: string,
  options: ThumbnailOptions = {},
): Promise<ImageTransformResult | null> {
  const { page = 1, ...transform } = { ...DEFAULTS, ...options };
  const type = mime.toLowerCase().split(';')[0]!.trim();

  try {
    if (type === 'application/pdf') {
      // Render with headroom over the target box so the resize stays sharp.
      const width = Math.min(2 * Math.max(transform.width ?? 0, transform.height ?? 0, 300), 4096);
      const png = await renderPdfPage(data, page, width);
      return await transformImage(png, transform);
    }
    if (type.startsWith('image/')) {
      return await transformImage(data, transform);
    }
    return null;
  }
  catch (error) {
    if (isMissingModule(error) || /optional peer dependency `sharp`/.test(String((error as Error)?.message))) {
      warnOnce(
        type,
        type === 'application/pdf'
          ? '[ablage] generateThumbnail: PDF previews need the optional dependencies `unpdf`, `@napi-rs/canvas` and `sharp`.'
          : '[ablage] generateThumbnail: image previews need the optional dependency `sharp`.',
      );
    }
    return null;
  }
}
