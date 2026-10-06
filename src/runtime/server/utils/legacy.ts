import type { FileObject, FileRef } from '../../../runtime/types';
import { computeEtag, deserializeObject, type SerializedFileObject } from './objects';

// Conversion of nuxt-filer 0.0.x metadata, shared by the migration helpers.
//
// 0.0.x stored a flat `FileMeta` ({ name, mime, type, version, ...custom }),
// with `_createdAt`/`_updatedAt` added by the unstorage and S3 providers.

/** Whether stored metadata is already in the current format. */
export function isCurrentMetadata(value: unknown): value is SerializedFileObject {
  return !!value && typeof value === 'object'
    && typeof (value as SerializedFileObject).etag === 'string'
    && typeof (value as SerializedFileObject).size === 'number';
}

const asDate = (value: unknown): Date | undefined => {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
};

/**
 * A FileObject for a 0.0.x file. `size` and `etag` come from the bytes;
 * `name` and `mime` become `name` / `contentType`, numeric `width`/`height`
 * stay system fields, and every other field — including the old `type` and
 * `version` — moves to `customMetadata`.
 */
export async function legacyToObject(
  ref: FileRef,
  legacy: Record<string, unknown> | null | undefined,
  data: Uint8Array,
  timestamps: { createdAt?: unknown; updatedAt?: unknown } = {},
): Promise<FileObject> {
  const { name, mime, width, height, _createdAt, _updatedAt, ...custom } = legacy ?? {};
  const uploadedAt = asDate(_createdAt) ?? asDate(timestamps.createdAt) ?? new Date();
  return {
    ...ref,
    size: data.length,
    contentType: typeof mime === 'string' && mime ? mime : 'application/octet-stream',
    etag: await computeEtag(data),
    uploadedAt,
    updatedAt: asDate(_updatedAt) ?? asDate(timestamps.updatedAt) ?? uploadedAt,
    ...(typeof name === 'string' && name ? { name } : {}),
    ...(typeof width === 'number' ? { width } : {}),
    ...(typeof height === 'number' ? { height } : {}),
    customMetadata: custom,
  };
}

/** Parse stored metadata of either format; `null` when it isn't an object. */
export function parseStoredMetadata(raw: unknown): { current?: FileObject; legacy?: Record<string, unknown> } | null {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    }
    catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  return isCurrentMetadata(value) ? { current: deserializeObject(value) } : { legacy: value as Record<string, unknown> };
}

/** Result of a migration run. */
export interface MigrationResult {
  /** Files whose metadata was converted (or created). */
  migrated: number;
  /** Files already in the current format. */
  skipped: number;
  /** Metadata without stored bytes, left untouched. */
  orphaned: string[];
}
