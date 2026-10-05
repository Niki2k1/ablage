export interface FileMeta {
  name: string;
  mime: string;
  type: string;
  version: number;
  username?: string;
  comment?: string;
  [key: string]: unknown;
}

/** Output image format for {@link transformImage}. */
export type ImageFormat = 'webp' | 'png' | 'jpeg' | 'avif' | 'gif';

/**
 * Options for upload-time image processing, backed by the optional `sharp`
 * peer dependency. Passed via `useFileStorage().upload(.., { transform })` or
 * to the standalone `transformImage()` util.
 */
export interface ImageTransformOptions {
  /** Target width in px. Combined with `fit` to bound the image. */
  width?: number;
  /** Target height in px. Combined with `fit` to bound the image. */
  height?: number;
  /**
   * How the image is resized to fit `width`/`height`. Mirrors sharp's `fit`.
   * Default: `'inside'` (preserve aspect ratio, fit within the box).
   */
  fit?: 'cover' | 'contain' | 'fill' | 'inside' | 'outside';
  /** Never scale the image up beyond its original size. Default: `true`. */
  withoutEnlargement?: boolean;
  /** Output format. Default: keep the input's format. */
  format?: ImageFormat;
  /** Output quality (1-100) for lossy formats (webp/jpeg/avif). */
  quality?: number;
  /**
   * Preserve every frame of multi-frame inputs (animated webp/gif). Default:
   * `true`; harmless for static images. Animation is only retained when the
   * output `format` is animation-capable (`webp`/`gif`).
   */
  animated?: boolean;
  /** Background used when flattening transparency (e.g. for `contain`/jpeg). */
  background?: string;
}

/** Result of {@link transformImage}: the processed bytes plus resolved metadata. */
export interface ImageTransformResult {
  /** The processed image bytes. */
  data: Buffer;
  /** MIME type of the processed image, e.g. `image/webp`. */
  mime: string;
  /** Resolved output format, e.g. `webp`. */
  format: string;
  /** Width of the processed image in px, if sharp could determine it. */
  width?: number;
  /** Height of the processed image in px, if sharp could determine it. */
  height?: number;
}

/** Reactive state of a single file tracked by `useTusUpload()`. */
export interface TusUploadState {
  file: File;
  /** Upload progress in percent (0-100). */
  progress: number;
  /** True once the tus upload finished successfully. */
  complete: boolean;
  /** Id of the staged upload on the server (last segment of `uploadUrl`). */
  tusId?: string;
  /** Full tus upload URL once the server assigned one. */
  uploadUrl?: string;
  /** Message of the last upload error, if any. */
  error?: string;
}

export interface UseTusUploadOptions {
  /** tus endpoint. Defaults to the route configured via `ablage.tus.route`. */
  endpoint?: string;
  /**
   * Extra tus metadata per file, merged over the default
   * `{ filename, filetype }` pair. Available server-side on the staged
   * upload and used by `useTusStaging().promote()` as meta fallbacks.
   */
  metadata?: (file: File) => Record<string, string>;
  /** Retry backoff in ms. Default: `[0, 3000, 5000, 10000, 20000]`. */
  retryDelays?: number[];
  /** Fixed chunk size in bytes. Default: let tus-js-client decide. */
  chunkSize?: number;
  /** Resume matching unfinished uploads from a previous session. Default: `true`. */
  resume?: boolean;
  /**
   * Delete staged uploads via `sendBeacon` when the page is closed while
   * uploads are still tracked (i.e. not yet promoted and `clear()`ed).
   * Trades resumability across page loads for a tidy staging area.
   * Default: `false`.
   */
  cleanupOnPageHide?: boolean;
  onError?: (file: File, error: Error) => void;
  onSuccess?: (file: File, state: TusUploadState) => void;
}

/** Options for `useTusStaging().promote()`. */
export interface TusPromoteOptions {
  /**
   * Overrides for the stored file's meta. Fields not given fall back to the
   * tus upload metadata (`filename`, `filetype`) and sensible defaults.
   */
  meta?: Partial<FileMeta>;
  /** Optional upload-time image processing, as in `useFileStorage().upload()`. */
  transform?: ImageTransformOptions;
  /** Remove the staged upload after promoting it. Default: `true`. */
  removeStaged?: boolean;
}

export interface ExternalRef {
  /** External system identifier, e.g. 'jira', 'sharepoint' */
  source: string;
  /** ID of the file in the external system */
  externalId: string;
  /** URL to the file in the external system */
  externalUrl?: string;
  /** When metadata/thumbnail was last synced */
  cachedAt?: Date;
}

export interface StoredFile {
  id: string;
  groupId: string;
  data?: Buffer;
  meta: FileMeta;
  external?: ExternalRef;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FileStorageExternalProvider {
  /** Sync local cache with the external system (pull latest metadata/thumbnail) */
  sync(groupId: string, id: string): Promise<void>;
  /** Push local file data and metadata to the external system */
  push(
    groupId: string,
    id: string,
    data: Buffer,
    meta: FileMeta
  ): Promise<void>;
  /** Pull a file from the external system into local storage */
  pull(groupId: string, externalRef: ExternalRef): Promise<StoredFile>;
}

export interface FileStorageProvider {
  create(
    groupId: string,
    data: Buffer | Uint8Array,
    meta?: FileMeta
  ): Promise<{ id: string }>;
  get(groupId: string, id: string): Promise<StoredFile | null>;
  /**
   * Like {@link get} but without reading the bytes (`data` is undefined).
   * Optional: when a provider doesn't implement it, callers fall back to `get()`.
   */
  head?(groupId: string, id: string): Promise<StoredFile | null>;
  getData(groupId: string, id: string): Promise<Buffer | null>;
  getMeta(id: string): Promise<FileMeta | null>;
  list(groupId: string): Promise<StoredFile[]>;
  update(id: string, meta: Partial<FileMeta>): Promise<void>;
  remove(groupId: string, id: string): Promise<void>;
  clear(groupId: string): Promise<void>;
  has(groupId: string, id: string): Promise<boolean>;
  findByMeta(filter: {
    key: string;
    value: unknown;
    groupId?: string;
  }): Promise<StoredFile | null>;

  /** Optional external file sync support */
  external?: FileStorageExternalProvider;
}
