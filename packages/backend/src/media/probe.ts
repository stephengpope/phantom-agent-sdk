// The technical facts of a media file, read once with ffprobe as it lands
// (Media.#record) and kept on its row (migration 068): width, height,
// duration, codecs — what anyone handling a video, image or audio file asks
// first. Read off the stored object through a short-lived link: ffprobe
// fetches by HTTP range, so it reads the headers (an MP4's moov box, an
// image's header), not the file. Headers only, no decoding, capped so no
// container can make it scan.
//
// A file ffprobe cannot read — a PDF, text, something broken — answers all
// null: the facts are a convenience of the row, never a condition of the
// upload. ffprobe not on PATH is the same answer, logged once.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger, errStr } from '../lib/log.js';

const log = logger('media-probe');
const run = promisify(execFile);

/** Give up on a probe after this long — a link that stalls is not worth an upload's wait. */
const PROBE_TIMEOUT_MS = 20_000;
/** How much of a file ffprobe may read to decide what it is (bytes); its default is 5 MB. */
const PROBE_SIZE = 10 * 1024 ** 2;
/** How far into the stream ffprobe may look for stream details (microseconds). */
const ANALYZE_DURATION_US = 5_000_000;
/** ffprobe's own JSON output, as much of it as is read here. */
interface FfprobeOutput {
  format?: { format_name?: string; duration?: string; bit_rate?: string };
  streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string;
    nb_frames?: string; pix_fmt?: string; channels?: number; sample_rate?: string }[];
}

/** The columns of migration 068, as the row takes them. */
export interface MediaFacts {
  width: number | null; height: number | null; durationSeconds: number | null; frameRate: number | null; frameCount: number | null;
  aspectRatio: string | null; orientation: 'landscape' | 'portrait' | 'square' | null; bitRate: number | null;
  videoCodec: string | null; audioCodec: string | null; audioChannels: number | null; audioSampleRate: number | null; hasAudio: boolean | null;
  pixelFormat: string | null; container: string | null; probe: unknown;
}

export const NO_FACTS: MediaFacts = {
  width: null, height: null, durationSeconds: null, frameRate: null, frameCount: null, aspectRatio: null, orientation: null, bitRate: null,
  videoCodec: null, audioCodec: null, audioChannels: null, audioSampleRate: null, hasAudio: null, pixelFormat: null, container: null, probe: null,
};

let missing = false;

/** The facts of the file at `url` (a presigned link), `size` bytes long. Never throws. */
export async function probeMedia(url: string, size: number): Promise<MediaFacts> {
  if (missing) return NO_FACTS;
  try {
    const { stdout } = await run('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
      '-probesize', String(PROBE_SIZE), '-analyzeduration', String(ANALYZE_DURATION_US), url],
    { timeout: PROBE_TIMEOUT_MS, maxBuffer: 16 * 1024 ** 2 });
    return factsOf(JSON.parse(stdout) as FfprobeOutput, size);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') { missing = true; log.warn('ffprobe is not installed: media rows get no technical facts'); }
    // A non-zero exit is ffprobe's "not media" (a PDF, text): the ordinary case, not a warning.
    else if (typeof (error as { code?: unknown }).code !== 'number') log.warn({ err: errStr(error) }, 'media probe failed');
    return NO_FACTS;
  }
}

/** ffprobe's answer as the row's columns. A still image is told by its
 *  container (image2*, *_pipe): ffprobe reports a fake one-frame duration
 *  for those, so duration, frame rate, frame count and bit rate stay null. */
export function factsOf(output: FfprobeOutput, size: number): MediaFacts {
  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  if (!video && !audio) return NO_FACTS;
  const container = output.format?.format_name?.split(',')[0] ?? null;
  const still = Boolean(container && (container.startsWith('image2') || container.endsWith('_pipe')));
  const duration = still ? null : number(output.format?.duration);
  const width = video?.width ?? null;
  const height = video?.height ?? null;
  const shape = width && height ? { aspectRatio: aspect(width, height), orientation: width > height ? 'landscape' as const : width < height ? 'portrait' as const : 'square' as const } : { aspectRatio: null, orientation: null };
  return {
    width, height, ...shape,
    durationSeconds: duration,
    frameRate: video && !still ? ratio(video.avg_frame_rate) ?? ratio(video.r_frame_rate) : null,
    frameCount: video && !still ? integer(video.nb_frames) : null,
    bitRate: still ? null : integer(output.format?.bit_rate) ?? (duration ? Math.round(size * 8 / duration) : null),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioChannels: audio?.channels ?? null,
    audioSampleRate: integer(audio?.sample_rate),
    hasAudio: Boolean(audio),
    pixelFormat: video?.pix_fmt ?? null,
    container,
    probe: output,
  };
}

const number = (text: string | undefined): number | null => { const n = Number(text); return text !== undefined && Number.isFinite(n) ? n : null; };
const integer = (text: string | undefined): number | null => { const n = number(text); return n === null ? null : Math.round(n); };
/** ffprobe's rates are fractions: `30000/1001`; `0/0` is "unknown". */
function ratio(text: string | undefined): number | null {
  const [top, bottom] = (text ?? '').split('/').map(Number);
  return top && bottom ? Math.round(top / bottom * 1000) / 1000 : null;
}
/** `1920×1080` → `16:9`. */
function aspect(width: number, height: number): string {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}
