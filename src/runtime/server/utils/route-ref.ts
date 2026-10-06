import type { FileRef } from '../../../runtime/types';
import { normalizeRef } from './objects';

/**
 * The file ref in a route path after `prefix` (`<group...>/<id>`, each segment
 * URL-encoded), or `null` when it isn't one.
 */
export function refFromPath(pathname: string, prefix: string): FileRef | null {
  if (!pathname.startsWith(`${prefix}/`)) return null;
  try {
    const parts = pathname.slice(prefix.length + 1).split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length < 2) return null;
    const id = parts.pop()!;
    return normalizeRef({ group: parts.join('/'), id });
  }
  catch {
    return null;
  }
}
