import { computed, reactive, getCurrentScope, onScopeDispose } from 'vue';
import type { CompletedPart, DirectUpload, DirectUploadState, UseDirectUploadOptions } from '../types';

export type { DirectUploadState, UseDirectUploadOptions };

const DEFAULT_RETRY_DELAYS = [0, 1000, 3000, 5000];
const DEFAULT_CONCURRENCY = 4;

/** Per-file bookkeeping that holds DOM handles, so it stays out of reactivity. */
interface Session {
  upload?: DirectUpload;
  controller: AbortController;
  etags: Map<number, string>;
  loaded: Map<number, number>;
}

class HttpStatusError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const abortError = () => new DOMException('Upload aborted', 'AbortError');

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  }
  catch {
    data = text;
  }
  if (!res.ok) {
    const message = (data as { message?: string } | undefined)?.message ?? `${res.status} ${res.statusText}`;
    throw new HttpStatusError(res.status, message);
  }
  return data as T;
}

/** PUT `body` with upload progress; resolves with the `ETag` response header. */
function put(
  url: string,
  body: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => onProgress(event.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('etag'));
      else reject(new HttpStatusError(xhr.status, `Upload failed: ${xhr.status} ${xhr.statusText}`));
    };
    xhr.onerror = () => reject(new Error('Upload failed: network error'));
    const onAbort = () => {
      xhr.abort();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', onAbort);
    xhr.send(body);
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(abortError());
    }, { once: true });
  });
}

/**
 * Uploads straight from the browser to the store (S3, R2, Garage, MinIO),
 * through presigned URLs from your own routes: `start` calls
 * `useFileStorage().createUpload()`, `complete` calls `completeUpload()`.
 * Large files go up in parts, in parallel; failed parts are retried, and
 * `retry()` continues an upload while its URLs are still valid.
 */
export function useDirectUpload<R = unknown>(options: UseDirectUploadOptions<R>) {
  const retryDelays = options.retryDelays ?? DEFAULT_RETRY_DELAYS;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const items = reactive<Record<string, DirectUploadState<R>>>({});
  const sessions = new Map<string, Session>();

  const uploading = computed(() =>
    Object.values(items).some((item) => !item.complete && !item.error),
  );
  const completed = computed(() =>
    Object.values(items).filter((item) => item.complete),
  );

  const callStart = (file: File) =>
    typeof options.start === 'string'
      ? postJson<DirectUpload>(options.start, { name: file.name, type: file.type, size: file.size })
      : options.start(file);

  const callComplete = (input: { token: string; parts?: CompletedPart[] }, file: File) =>
    typeof options.complete === 'string'
      ? postJson<R>(options.complete, input)
      : options.complete(input, file);

  const callAbort = async (token: string, file: File) => {
    if (!options.abort) return;
    if (typeof options.abort === 'string') await postJson(options.abort, { token });
    else await options.abort({ token }, file);
  };

  /** A PUT, retried on network errors and 5xx; 4xx (e.g. an expired URL) fails at once. */
  async function putWithRetry(
    url: string,
    body: Blob,
    headers: Record<string, string>,
    onProgress: (loaded: number) => void,
    signal: AbortSignal,
  ): Promise<string | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await put(url, body, headers, onProgress, signal);
      }
      catch (error) {
        const retryable = !signal.aborted
          && !(error instanceof HttpStatusError && error.status < 500)
          && attempt < retryDelays.length - 1;
        if (!retryable) throw error;
        onProgress(0);
        await wait(retryDelays[attempt + 1]!, signal);
      }
    }
  }

  async function run(key: string) {
    const state = items[key];
    const session = sessions.get(key);
    if (!state || !session) return;
    const { file } = state;
    const { signal } = session.controller;
    const report = () => {
      const loaded = [...session.loaded.values()].reduce((sum, bytes) => sum + bytes, 0);
      state.progress = file.size ? Math.min(100, (loaded / file.size) * 100) : 0;
    };

    try {
      if (session.upload && Date.parse(session.upload.expiresAt) <= Date.now()) {
        // Its URLs no longer work: drop what was sent and start over.
        await callAbort(session.upload.token, file).catch(() => {});
        session.upload = undefined;
        session.etags.clear();
        session.loaded.clear();
      }
      session.upload ??= await callStart(file);
      const upload = session.upload;
      if (signal.aborted) return;

      let parts: CompletedPart[] | undefined;
      if (upload.type === 'single') {
        await putWithRetry(upload.url, file, upload.headers, (loaded) => {
          session.loaded.set(1, loaded);
          report();
        }, signal);
      }
      else {
        const pending = upload.parts.filter((part) => !session.etags.has(part.number));
        let failed = false;
        const worker = async () => {
          for (let part = pending.shift(); part && !failed; part = pending.shift()) {
            const start = (part.number - 1) * upload.partSize;
            const number = part.number;
            const etag = await putWithRetry(part.url, file.slice(start, start + part.size), {}, (loaded) => {
              session.loaded.set(number, loaded);
              report();
            }, signal);
            if (!etag) {
              throw new Error('The store did not expose the ETag header; add it to the bucket\'s CORS ExposeHeaders');
            }
            session.etags.set(number, etag);
          }
        };
        const guarded = () => worker().catch((error) => {
          failed = true;
          throw error;
        });
        await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, guarded));
        parts = [...session.etags].map(([number, etag]) => ({ number, etag }));
      }

      const result = await callComplete({ token: upload.token, ...(parts ? { parts } : {}) }, file);
      state.result = result;
      state.progress = 100;
      state.complete = true;
      options.onSuccess?.(file, state);
    }
    catch (error) {
      if (signal.aborted) return;
      state.error = error instanceof Error ? error.message : String(error);
      options.onError?.(file, error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Upload a file; tracked by file name. Resolves when it completed or failed. */
  async function start(file: File): Promise<DirectUploadState<R>> {
    const key = file.name;
    sessions.get(key)?.controller.abort();
    items[key] = { file, progress: 0, complete: false };
    sessions.set(key, { controller: new AbortController(), etags: new Map(), loaded: new Map() });
    await run(key);
    return items[key]!;
  }

  /** Start uploads for files not tracked yet (idempotent per file name). */
  function add(files: File | File[]) {
    for (const file of Array.isArray(files) ? files : [files]) {
      if (!items[file.name]) void start(file);
    }
  }

  /** Continue a failed upload, re-sending only the parts that didn't finish. */
  async function retry(file: File | string): Promise<DirectUploadState<R> | undefined> {
    const key = typeof file === 'string' ? file : file.name;
    const state = items[key];
    const session = sessions.get(key);
    if (!state || !session || state.complete || !state.error) return state;
    state.error = undefined;
    if (session.controller.signal.aborted) session.controller = new AbortController();
    await run(key);
    return items[key];
  }

  /** Stop a file's upload, drop what was sent, and stop tracking it. */
  async function remove(file: File | string) {
    const key = typeof file === 'string' ? file : file.name;
    const state = items[key];
    const session = sessions.get(key);
    sessions.delete(key);
    Reflect.deleteProperty(items, key);
    session?.controller.abort();
    if (state && session?.upload && !state.complete) {
      await callAbort(session.upload.token, state.file).catch(() => {});
    }
  }

  /** Stop tracking all files; unfinished transfers are stopped, nothing is deleted. */
  function clear() {
    for (const session of sessions.values()) session.controller.abort();
    sessions.clear();
    for (const key of Object.keys(items)) Reflect.deleteProperty(items, key);
  }

  /** Stop everything and drop what unfinished uploads sent. */
  async function cancel() {
    await Promise.allSettled(Object.keys(items).map((key) => remove(key)));
  }

  if (import.meta.client) {
    const onOnline = () => {
      for (const [key, item] of Object.entries(items)) {
        if (item.error && !item.complete) void retry(key);
      }
    };
    window.addEventListener('online', onOnline);
    if (getCurrentScope()) {
      onScopeDispose(() => window.removeEventListener('online', onOnline));
    }
  }

  return {
    items,
    uploading,
    completed,
    start,
    add,
    retry,
    remove,
    clear,
    cancel,
  };
}
