import { computed, reactive, getCurrentScope, onScopeDispose } from 'vue';
import { useRuntimeConfig } from 'nuxt/app';
import { Upload as TusUpload } from 'tus-js-client';
import type { TusUploadState, UseTusUploadOptions } from '../types';

export type { TusUploadState, UseTusUploadOptions };

const DEFAULT_RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];

/**
 * Resumable uploads against the module's tus endpoint. Files are staged on
 * the server; move them into the file storage afterwards with
 * `useTusStaging().promote()` from one of your own server routes.
 */
export function useTusUpload(options: UseTusUploadOptions = {}) {
  const runtimeConfig = useRuntimeConfig();
  const endpoint =
    options.endpoint
    ?? (runtimeConfig.public.ablage as { tusRoute?: string } | undefined)
      ?.tusRoute
    ?? '/_ablage/tus';

  const items = reactive<Record<string, TusUploadState>>({});
  // tus Upload instances hold DOM/file handles — keep them out of reactivity.
  const instances = new Map<string, TusUpload>();

  const uploading = computed(() =>
    Object.values(items).some((item) => !item.complete && !item.error)
  );
  const completed = computed(() =>
    Object.values(items).filter((item) => item.complete)
  );

  function captureUploadUrl(state: TusUploadState, upload: TusUpload) {
    if (upload.url && !state.tusId) {
      state.uploadUrl = upload.url;
      state.tusId = upload.url.split('/').pop();
    }
  }

  async function start(file: File): Promise<TusUploadState> {
    const key = file.name;
    const state: TusUploadState = { file, progress: 0, complete: false };
    items[key] = state;

    const upload = new TusUpload(file, {
      endpoint,
      retryDelays: options.retryDelays ?? DEFAULT_RETRY_DELAYS,
      chunkSize: options.chunkSize,
      removeFingerprintOnSuccess: true,
      metadata: {
        filename: file.name,
        filetype: file.type,
        ...options.metadata?.(file),
      },
      onError(error) {
        const item = items[key];
        if (!item) return;
        item.error = error instanceof Error ? error.message : String(error);
        options.onError?.(file, error as Error);
      },
      onProgress(bytesUploaded, bytesTotal) {
        const item = items[key];
        if (!item) return;
        item.progress = bytesTotal ? (bytesUploaded / bytesTotal) * 100 : 0;
        captureUploadUrl(item, upload);
      },
      onSuccess() {
        const item = items[key];
        if (!item) return;
        captureUploadUrl(item, upload);
        item.progress = 100;
        item.complete = true;
        options.onSuccess?.(file, item);
      },
    });
    instances.set(key, upload);

    if (options.resume !== false) {
      const previous = await upload.findPreviousUploads().catch(() => []);
      if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
    }

    upload.start();
    return state;
  }

  /** Start uploads for files not tracked yet (idempotent per file name). */
  function add(files: File | File[]) {
    for (const file of Array.isArray(files) ? files : [files]) {
      if (!items[file.name]) void start(file);
    }
  }

  /** Abort a file's upload, delete its staged data, and stop tracking it. */
  async function remove(file: File | string) {
    const key = typeof file === 'string' ? file : file.name;
    const state = items[key];
    const upload = instances.get(key);
    instances.delete(key);
    Reflect.deleteProperty(items, key);

    if (upload) {
      // terminate = tus DELETE; the staged upload may already be gone.
      await upload.abort(true).catch(() => {});
    } else if (state?.uploadUrl) {
      await fetch(state.uploadUrl, {
        method: 'DELETE',
        headers: { 'Tus-Resumable': '1.0.0' },
      }).catch(() => {});
    }
  }

  /** Stop tracking all files without touching staged data (e.g. after promoting). */
  function clear() {
    for (const upload of instances.values()) {
      void upload.abort().catch(() => {});
    }
    instances.clear();
    for (const key of Object.keys(items)) Reflect.deleteProperty(items, key);
  }

  /** Abort everything and delete all staged uploads. */
  async function cancel() {
    await Promise.allSettled(Object.keys(items).map((key) => remove(key)));
  }

  if (import.meta.client) {
    // Connection loss beyond retryDelays surfaces as an error; restarting the
    // same Upload instance continues from the last confirmed offset.
    const onOnline = () => {
      for (const [key, upload] of instances) {
        const item = items[key];
        if (item && !item.complete) {
          item.error = undefined;
          upload.start();
        }
      }
    };
    const onPageHide = () => {
      if (!options.cleanupOnPageHide) return;
      const tusIds = Object.values(items)
        .map((item) => item.tusId)
        .filter((id): id is string => !!id);
      if (tusIds.length === 0) return;
      navigator.sendBeacon(
        `${endpoint}/cleanup`,
        new Blob([JSON.stringify({ tusIds })], { type: 'application/json' })
      );
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('pagehide', onPageHide);
    if (getCurrentScope()) {
      onScopeDispose(() => {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('pagehide', onPageHide);
      });
    }
  }

  return {
    endpoint,
    items,
    uploading,
    completed,
    start,
    add,
    remove,
    clear,
    cancel,
  };
}
