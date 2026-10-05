import type { ImageTransformOptions } from '../../../runtime/types';

/** IPX-style modifiers, e.g. `{ w: '200', f: 'webp' }` for `w_200,f_webp`. */
export type ImageModifiers = Record<string, string>;

export interface ImageServiceConfig {
  service: 'imgproxy' | 'ipx';
  /** The module's image route (`ablage.image.route`), which serves originals at `<route>/_/…`. */
  route: string;
  /** Base URL of the image service. */
  baseURL: string;
  /** imgproxy signing key (hex). Unsigned (`insecure`) URLs when unset. */
  key?: string;
  /** imgproxy signing salt (hex). */
  salt?: string;
  /**
   * Origin the service fetches originals from, e.g. `http://app:3000` on a
   * private network. Defaults to the incoming request's origin; required for
   * upload-time transforms, which have no request to derive it from.
   */
  sourceURL?: string;
}

/** Parse an IPX modifier segment (`w_200,f_webp`, or `_` for none). */
export function parseModifiers(segment: string): ImageModifiers {
  const modifiers: ImageModifiers = {};
  if (!segment || segment === '_') return modifiers;
  for (const part of segment.split(',')) {
    const [key, ...values] = part.split('_');
    if (key) modifiers[key] = decodeURIComponent(values.join('_'));
  }
  return modifiers;
}

function stringifyModifiers(modifiers: ImageModifiers): string {
  const parts = Object.entries(modifiers).map(([key, value]) =>
    value === '' ? key : `${key}_${encodeURIComponent(value)}`,
  );
  return parts.length ? parts.join(',') : '_';
}

/** URL of a stored original as served by the module's image route (`<route>/_/<group>/<id>`). */
export function sourceURL(config: ImageServiceConfig, origin: string, groupId: string, id: string): string {
  const path = [...groupId.split('/').filter(Boolean), id].map(encodeURIComponent).join('/');
  return `${origin.replace(/\/+$/, '')}${config.route}/_/${path}`;
}

/** `upload({ transform })` options expressed as IPX modifiers. */
export function transformToModifiers(options: ImageTransformOptions): ImageModifiers {
  const modifiers: ImageModifiers = {};
  if (options.width != null) modifiers.w = String(options.width);
  if (options.height != null) modifiers.h = String(options.height);
  if (options.width != null || options.height != null) {
    modifiers.fit = options.fit ?? 'inside';
    if (options.withoutEnlargement === false) modifiers.enlarge = '';
  }
  if (options.format) modifiers.f = options.format;
  if (options.quality != null) modifiers.q = String(options.quality);
  if (options.background) modifiers.b = options.background.replace(/^#/, '');
  if (options.animated ?? true) modifiers.a = '';
  return modifiers;
}

const IMGPROXY_FIT: Record<string, string> = {
  cover: 'fill',
  contain: 'fit',
  fill: 'force',
  inside: 'fit',
  outside: 'fill',
};

const IMGPROXY_GRAVITY: Record<string, string> = {
  center: 'ce',
  centre: 'ce',
  top: 'no',
  north: 'no',
  bottom: 'so',
  south: 'so',
  left: 'we',
  west: 'we',
  right: 'ea',
  east: 'ea',
  northeast: 'noea',
  northwest: 'nowe',
  southeast: 'soea',
  southwest: 'sowe',
  entropy: 'sm',
  attention: 'sm',
};

/**
 * Translate IPX modifiers into imgproxy processing options. Only modifiers
 * with an imgproxy equivalent are mapped; others are dropped rather than
 * producing an invalid URL.
 */
export function toImgproxyOptions(modifiers: ImageModifiers): string[] {
  const m = { ...modifiers };
  for (const [alias, key] of [['width', 'w'], ['height', 'h'], ['format', 'f'], ['quality', 'q'], ['background', 'b'], ['position', 'pos'], ['resize', 's']]) {
    if (m[alias!] !== undefined) m[key!] ??= m[alias!]!;
  }
  if (m.s) {
    const [w = '', h = ''] = m.s.split('x');
    m.w = w;
    m.h = h;
  }

  const options: string[] = [];
  const width = Number(m.w) || 0;
  const height = Number(m.h) || 0;
  if (width || height) {
    // Like sharp/IPX: an explicit box defaults to cover, a single edge to a fit.
    const fit = IMGPROXY_FIT[m.fit ?? (width && height ? 'cover' : 'inside')] ?? 'fit';
    options.push(`rs:${fit}:${width}:${height}`);
    if (m.fit === 'contain') options.push('ex:1');
  }
  if (m.enlarge !== undefined) options.push('el:1');
  const gravity = m.pos && IMGPROXY_GRAVITY[m.pos.toLowerCase()];
  if (gravity) options.push(`g:${gravity}`);
  if (m.b && /^[0-9a-f]{3,8}$/i.test(m.b)) options.push(`bg:${m.b}`);
  if (Number(m.q)) options.push(`q:${Number(m.q)}`);
  if (Number(m.blur)) options.push(`bl:${Number(m.blur)}`);
  if (Number(m.sharpen)) options.push(`sh:${Number(m.sharpen)}`);
  if (Number(m.rotate)) options.push(`rot:${Number(m.rotate)}`);
  if (m.f) options.push(`f:${m.f === 'jpeg' ? 'jpg' : m.f}`);
  return options;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const hexBytes = (hex: string) =>
  new Uint8Array(hex.match(/../g)?.map((byte) => Number.parseInt(byte, 16)) ?? []);

/** imgproxy URL signature: base64url(HMAC-SHA256(key, salt + path)). WebCrypto, so it runs in isolates. */
export async function signImgproxyPath(path: string, key: string, salt: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    hexBytes(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const pathBytes = new TextEncoder().encode(path);
  const saltBytes = hexBytes(salt);
  const message = new Uint8Array(saltBytes.length + pathBytes.length);
  message.set(saltBytes);
  message.set(pathBytes, saltBytes.length);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, message)));
}

/** Build the service URL that renders `source` with `modifiers`. */
export async function imageServiceURL(
  config: ImageServiceConfig,
  modifiers: ImageModifiers,
  source: string,
): Promise<string> {
  if (config.service === 'ipx') {
    return `${config.baseURL}/${stringifyModifiers(modifiers)}/${source}`;
  }
  const options = toImgproxyOptions(modifiers);
  const path = `/${[...options, base64url(new TextEncoder().encode(source))].join('/')}`;
  const signature = config.key && config.salt
    ? await signImgproxyPath(path, config.key, config.salt)
    : 'insecure';
  return `${config.baseURL}/${signature}${path}`;
}
