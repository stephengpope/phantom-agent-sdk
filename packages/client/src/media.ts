// Media — the backend's tracked files on S3-compatible storage, over its
// /media routes (the service role's; an app's own users reach files through
// the app's /app routes). Two ways to send a file:
//   - upload(bytes)  — through the backend, streamed: a server, a script, a cli
//   - uploadDirect(file) — a browser sending straight to storage on presigned
//     URLs (one PUT, or parts for a large file), then completing — the file
//     is recorded only then. The bucket needs a CORS rule for the page's
//     origin (setup).
// Files come back as short-lived links: links(ids) for a page's worth at once.
import type { BackendClient } from './backend.js';

/** One tracked file, as the backend answers it. */
export interface MediaFile {
  id: string;
  organizationId: string | null;
  userId: string | null;
  projectId: string | null;
  sessionId: string | null;
  name: string;
  mimeType: string;
  size: number;
  /** How it came to be: a dropped attachment, the agent's own upload, a URL it fetched, a browser's direct upload, a call to the API. Null for rows from before. */
  source: 'attachment' | 'agent' | 'url' | 'browser' | 'api' | null;
  endpoint: string;
  bucket: string;
  key: string;
  /** The file's technical facts, read once with ffprobe as it landed; all null for a file ffprobe could not read (a PDF, text). */
  width: number | null;
  height: number | null;
  durationSeconds: number | null;
  frameRate: number | null;
  frameCount: number | null;
  /** `16:9`, `9:16`, `1:1`. */
  aspectRatio: string | null;
  orientation: 'landscape' | 'portrait' | 'square' | null;
  bitRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  audioSampleRate: number | null;
  hasAudio: boolean | null;
  pixelFormat: string | null;
  /** The container as ffprobe names it: `mov`, `matroska`, `mp3`, `png_pipe`. */
  container: string | null;
  /** ffprobe's whole answer. */
  probe: unknown;
  createdAt: string;
  updatedAt: string;
}

/** Who a file belongs to; nothing = the service role's. */
export type MediaOwner = { organization?: string; project?: string; user?: string };

export type MediaUploadPlan =
  | { mode: 'single'; url: string; headers: Record<string, string> }
  | { mode: 'multipart'; uploadId: string; partSize: number; parts: { partNumber: number; url: string }[] };

export interface MediaLink { id: string; url: string; expiresAt: string }

/** What `complete` needs of a plan carried out: the parts' ETags for a multipart upload, nothing for a single PUT. */
export type MediaUploadSent = { uploadId?: string; parts?: { partNumber: number; etag: string }[] };

/** Parts in flight at once for a direct upload. */
const PART_CONCURRENCY = 4;

/** Carry an upload plan out: the file's bytes to storage, straight from
 *  wherever the Blob is (a browser's File, a host's file-backed Blob), one
 *  PUT or PART_CONCURRENCY parts at a time. Answers what `complete` needs. */
export async function sendToStorage(file: Blob, plan: MediaUploadPlan, signal?: AbortSignal): Promise<MediaUploadSent> {
  if (plan.mode === 'single') { await put(plan.url, file, plan.headers, signal); return {}; }
  const { partSize, parts } = plan;
  const etags: { partNumber: number; etag: string }[] = [];
  let next = 0;
  const worker = async () => {
    for (let part = parts[next++]; part; part = parts[next++]) {
      const start = (part.partNumber - 1) * partSize;
      const etag = await put(part.url, file.slice(start, start + partSize), {}, signal);
      etags.push({ partNumber: part.partNumber, etag });
    }
  };
  await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, worker));
  return { uploadId: plan.uploadId, parts: etags };
}

const query = (params: Record<string, string | number | undefined>): string => {
  const entries = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined);
  return entries.length ? `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}` : '';
};

export class Media {
  constructor(private readonly backend: BackendClient) {}

  /** Ready files, newest first. */
  async list(filter: MediaOwner & { limit?: number } = {}): Promise<MediaFile[]> {
    return (await this.backend.call<{ media: MediaFile[] }>('GET', `/media${query(filter)}`)).media;
  }

  get(id: string): Promise<MediaFile> {
    return this.backend.call<MediaFile>('GET', `/media/${encodeURIComponent(id)}`);
  }

  /** Send a file through the backend; answers it ready. `type`: what the
   *  sender believes it is — the backend reads the real type from the bytes. */
  upload(bytes: Blob | Uint8Array | ReadableStream<Uint8Array>, options: MediaOwner & { name: string; type?: string }): Promise<MediaFile> {
    return this.backend.callBytes<MediaFile>('POST', `/media${query(options)}`, bytes as BodyInit, 'application/octet-stream');
  }

  /** Start a direct upload: its id and the URLs to PUT to. Nothing is
   *  recorded until `complete`. */
  startUpload(options: MediaOwner & { name: string; size: number; type: string }): Promise<{ id: string; upload: MediaUploadPlan }> {
    return this.backend.call('POST', '/media/uploads', options);
  }

  /** After the PUTs: what was declared at the start, and for a multipart
   *  upload its id and each part's ETag. Answers the file, recorded. */
  complete(id: string, options: MediaOwner & { name: string; size: number; type: string; uploadId?: string; parts?: { partNumber: number; etag: string }[] }): Promise<MediaFile> {
    const { uploadId, parts, ...rest } = options;
    return this.backend.call<MediaFile>('POST', `/media/uploads/${encodeURIComponent(id)}/complete`, { ...rest, ...(uploadId ? { upload_id: uploadId } : {}), ...(parts ? { parts } : {}) });
  }

  /** A direct upload given up on: its bytes and parts are removed. */
  async abandon(id: string, options: { organization?: string; uploadId?: string } = {}): Promise<void> {
    await this.backend.call('DELETE', `/media/uploads/${encodeURIComponent(id)}${query({ organization: options.organization, upload_id: options.uploadId })}`);
  }

  /** The whole direct flow for a browser File/Blob: start, PUT the bytes
   *  straight to storage, complete. A failure removes the half-sent bytes. */
  async uploadDirect(file: Blob, options: MediaOwner & { name: string; type?: string; signal?: AbortSignal }): Promise<MediaFile> {
    const { signal, ...owner } = options;
    const declared = { ...owner, size: file.size, type: options.type || file.type || 'application/octet-stream' };
    const started = await this.startUpload(declared);
    const uploadId = started.upload.mode === 'multipart' ? started.upload.uploadId : undefined;
    try {
      return await this.complete(started.id, { ...declared, ...(await sendToStorage(file, started.upload, signal)) });
    } catch (error) {
      await this.abandon(started.id, { organization: owner.organization, uploadId }).catch(() => {});
      throw error;
    }
  }

  /** Short-lived links, one per id, in order. */
  async links(ids: string[], seconds?: number): Promise<MediaLink[]> {
    return (await this.backend.call<{ links: MediaLink[] }>('POST', '/media/links', { ids, ...(seconds ? { seconds } : {}) })).links;
  }

  async delete(id: string): Promise<void> {
    await this.backend.call('DELETE', `/media/${encodeURIComponent(id)}`);
  }

  /** Let web apps on `origins` upload to and play from the bucket directly. */
  setup(origins: string[], organization?: string): Promise<{ cors: 'set' | 'unsupported'; message?: string; rule: object }> {
    return this.backend.call('POST', '/media/setup', { origins, ...(organization ? { organization } : {}) });
  }
}

/** One PUT to storage; answers its ETag. The bucket's CORS rule must expose
 *  ETag. A connection that fails (fetch's own TypeError — most often a
 *  kept-alive socket the far end closed as this request reused it) is tried
 *  once more: a Blob replays, and a PUT to one key is idempotent. Storage's
 *  own answer (a 4xx/5xx) is never retried. */
async function put(url: string, body: Blob, headers: Record<string, string>, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', body, headers, signal });
  } catch (error) {
    if (!(error instanceof TypeError) || signal?.aborted) throw error;
    response = await fetch(url, { method: 'PUT', body, headers, signal });
  }
  if (!response.ok) throw new Error(`storage refused the upload: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
  return response.headers.get('etag') ?? '';
}
