import type { ProviderGetImage } from '@nuxt/image';
import { joinURL } from 'ufo';

interface AblageImageProviderOptions {
  baseURL?: string;
}

const operationsGenerator = (
  modifiers: Record<string, string | number | boolean | undefined>
): string => {
  const out: string[] = [];
  // Match @nuxt/image's built-in IPX provider: width+height collapses to resize.
  if (modifiers.width && modifiers.height) {
    modifiers.resize = `${modifiers.width}x${modifiers.height}`;
    delete modifiers.width;
    delete modifiers.height;
  }
  const keyMap: Record<string, string> = {
    format: 'f',
    width: 'w',
    height: 'h',
    resize: 's',
    quality: 'q',
    background: 'b',
    position: 'pos',
  };
  for (const [rawKey, value] of Object.entries(modifiers)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    const key = keyMap[rawKey] ?? rawKey;
    out.push(`${key}_${value}`);
  }
  return out.length ? out.join(',') : '_';
};

export const getImage: ProviderGetImage = (
  src: string,
  { modifiers = {}, baseURL = '/_ablage/image' }: { modifiers?: Record<string, unknown>; baseURL?: string } = {},
) => {
  const ops = operationsGenerator(
    modifiers as Record<string, string | number | boolean | undefined>
  );
  return { url: joinURL(baseURL, ops, src.replace(/^\/+/, '')) };
};

export default () => ({
  getImage,
  validateDomains: false,
  supportsAlias: false,
});

export type { AblageImageProviderOptions };
