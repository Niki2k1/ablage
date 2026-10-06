import type {
  CompletedPart,
  CreateUploadOptions,
  CustomMetadata,
  DirectUpload,
  FileObject,
  FileRef,
  FileStorageProvider,
  ProviderDirectUploads,
} from '../../../runtime/types';
import { deriveSecret } from 'nuxt/server';
import { assertId, httpError, normalizeGroup } from './objects';
import { signToken, verifyToken } from './signing';
import { formatSize, matchesType, parseSize } from './upload';

/** `deriveSecret()` purpose for direct upload tokens. */
const TOKEN_PURPOSE = 'ablage:direct-upload';

const MiB = 1024 * 1024;
const DEFAULT_PART_SIZE = 16 * MiB;
// S3 limits: parts of at least 5 MiB (except the last), at most 10,000 parts,
// and at most 5 GiB per PUT.
const MIN_PART_SIZE = 5 * MiB;
const MAX_PART_SIZE = 5 * 1024 * MiB;
const MAX_PARTS = 10_000;
/** How long after the URLs expire `completeUpload()` still accepts a token: a PUT started in time may still be running. */
const COMPLETE_GRACE = 60 * 60;

/** What a direct upload token vouches for. */
interface UploadClaims {
  group: string;
  id: string;
  size: number;
  contentType: string;
  name?: string;
  cacheControl?: string;
  customMetadata: CustomMetadata;
  uploadId?: string;
  parts?: number;
  expires: number;
}

/** Part size for `size` bytes: the requested size, raised to fit S3's limits. */
export function choosePartSize(size: number, requested = DEFAULT_PART_SIZE): number {
  const partSize = Math.max(Math.floor(requested), MIN_PART_SIZE, Math.ceil(size / MAX_PARTS));
  return Math.min(Math.ceil(partSize / MiB) * MiB, MAX_PART_SIZE);
}

/** `createUpload()` / `completeUpload()` / `abortUpload()` of `useFileStorage()`. */
export function directUploadApi(provider: FileStorageProvider) {
  const uploads = (): ProviderDirectUploads => {
    if (!provider.directUploads) {
      throw new Error('[ablage] the configured storage provider does not support direct uploads (S3 needs `publicEndpoint`)');
    }
    return provider.directUploads;
  };

  const readToken = async (token: string): Promise<UploadClaims> => {
    const claims = await verifyToken<UploadClaims>(await deriveSecret(TOKEN_PURPOSE), token);
    if (!claims) throw httpError(403, 'Invalid or expired upload token');
    return claims;
  };

  /**
   * Start an upload that the browser sends straight to the store. Returns
   * presigned URLs and a signed `token`; nothing is listed until
   * {@link completeUpload} succeeds.
   */
  async function createUpload<M extends CustomMetadata = CustomMetadata>(
    group: string,
    options: CreateUploadOptions<M>,
  ): Promise<DirectUpload> {
    const direct = uploads();
    const ref = { group: normalizeGroup(group), id: options.id ?? crypto.randomUUID() };
    assertId(ref.id);

    const { size } = options;
    if (!Number.isSafeInteger(size) || size < 0) throw httpError(400, 'Upload size must be a non-negative integer');
    const contentType = options.contentType || 'application/octet-stream';
    const maxSize = options.maxSize === undefined ? undefined : parseSize(options.maxSize);
    if (maxSize !== undefined && size > maxSize) throw httpError(413, `File too large (max ${formatSize(maxSize)})`);
    if (options.types && !matchesType({ name: options.name ?? '', type: contentType }, options.types)) {
      throw httpError(415, `File type "${contentType}" is not allowed`);
    }
    // Overwriting isn't offered: the PUT would replace the bytes before completion.
    if (options.id !== undefined && await provider.head(ref)) {
      throw httpError(409, `File "${ref.group}/${ref.id}" already exists`);
    }

    const expiresIn = Math.max(1, Math.floor(options.expiresIn ?? 3600));
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const partSize = choosePartSize(size, options.partSize);
    const target = await direct.create(ref, { size, contentType, expiresIn, partSize });

    const claims: UploadClaims = {
      ...ref,
      size,
      contentType,
      ...(options.name !== undefined ? { name: options.name } : {}),
      ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
      customMetadata: options.customMetadata ?? {},
      ...(target.type === 'multipart' ? { uploadId: target.uploadId, parts: target.parts.length } : {}),
      expires: expires + COMPLETE_GRACE,
    };
    const token = await signToken(await deriveSecret(TOKEN_PURPOSE), claims);
    return { ...target, ...ref, token, expiresAt: new Date(expires * 1000).toISOString() };
  }

  /**
   * Finish an upload started with {@link createUpload}: completes a multipart
   * upload, checks the stored size and writes the metadata. `customMetadata`
   * is merged over what was declared at the start.
   */
  async function completeUpload<M extends CustomMetadata = CustomMetadata>(
    token: string,
    options: { parts?: CompletedPart[]; customMetadata?: Partial<M> } = {},
  ): Promise<FileObject<M>> {
    const direct = uploads();
    const claims = await readToken(token);
    const ref: FileRef = { group: claims.group, id: claims.id };
    if (await provider.head(ref)) throw httpError(409, `Upload "${ref.group}/${ref.id}" was already completed`);

    let parts: CompletedPart[] | undefined;
    if (claims.uploadId) {
      parts = [...(options.parts ?? [])].sort((a, b) => a.number - b.number);
      const valid = parts.length === claims.parts
        && parts.every((part, index) => part.number === index + 1 && typeof part.etag === 'string' && part.etag);
      if (!valid) throw httpError(400, `Expected the ETags of parts 1 to ${claims.parts}`);
    }

    const stored = await direct.finish(ref, { uploadId: claims.uploadId, parts });
    if (!stored) throw httpError(400, `Upload "${ref.group}/${ref.id}" has no data yet`);
    if (stored.size !== claims.size) {
      await direct.abort(ref, {});
      throw httpError(400, `Upload "${ref.group}/${ref.id}" has ${stored.size} bytes, expected ${claims.size}`);
    }

    const now = new Date();
    const object: FileObject<M> = {
      ...ref,
      size: stored.size,
      contentType: claims.contentType,
      etag: stored.etag,
      uploadedAt: now,
      updatedAt: now,
      ...(claims.name !== undefined ? { name: claims.name } : {}),
      ...(claims.cacheControl !== undefined ? { cacheControl: claims.cacheControl } : {}),
      customMetadata: { ...claims.customMetadata, ...options.customMetadata } as M,
    };
    await direct.commit(object);
    return object;
  }

  /** Cancel an unfinished upload and drop what was sent; a completed upload is left alone. */
  async function abortUpload(token: string): Promise<void> {
    const direct = uploads();
    const claims = await readToken(token);
    const ref: FileRef = { group: claims.group, id: claims.id };
    if (await provider.head(ref)) return;
    await direct.abort(ref, { uploadId: claims.uploadId });
  }

  return { createUpload, completeUpload, abortUpload };
}
