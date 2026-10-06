import type { FileRef } from '../../../runtime/types';

// Framework-free signing for `signedUrl()` links: HMAC-SHA256 over the file,
// expiry and disposition, with a key the caller supplies.

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message))));
}

/** What a signature covers. */
export interface SignedFileClaims extends FileRef {
  /** Expiry as a Unix timestamp in seconds. */
  expires: number;
  /** Serve as a download (`content-disposition: attachment`). */
  download: boolean;
}

const payload = (claims: SignedFileClaims) =>
  `${claims.group}\n${claims.id}\n${claims.expires}\n${claims.download ? 1 : 0}`;

export function signFileClaims(key: string, claims: SignedFileClaims): Promise<string> {
  return hmac(key, payload(claims));
}

/** Constant-time comparison of two signatures. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Whether `signature` is valid for the claims and they haven't expired. */
export async function verifyFileClaims(
  key: string,
  claims: SignedFileClaims,
  signature: string,
  now = Date.now(),
): Promise<boolean> {
  if (!Number.isFinite(claims.expires) || claims.expires * 1000 <= now) return false;
  return safeEqual(await signFileClaims(key, claims), signature);
}

/** `group` path segments and the id, each URL-encoded. */
export function refPath(ref: FileRef): string {
  return [...ref.group.split('/'), ref.id].map(encodeURIComponent).join('/');
}
