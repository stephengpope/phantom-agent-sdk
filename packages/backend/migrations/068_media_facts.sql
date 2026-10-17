-- The technical facts of a media file, read once with ffprobe as it lands
-- (media/Media.ts, #record) and kept on its row: what anyone handling a
-- video, image or audio file asks first, one lookup instead of a download
-- and a probe per reader. All nullable: an image fills its dimensions and
-- codecs; a video everything; audio its duration and audio columns; a file
-- ffprobe cannot read (a PDF, text) leaves them all null and still uploads.
-- `probe` is ffprobe's whole answer, so nothing is lost.
alter table phantom_agent_sdk.media
  add column width integer,
  add column height integer,
  add column duration_seconds numeric(12,3),
  add column frame_rate numeric(8,3),
  add column frame_count integer,
  add column aspect_ratio text,
  add column orientation text,
  add column bit_rate bigint,
  add column video_codec text,
  add column audio_codec text,
  add column audio_channels integer,
  add column audio_sample_rate integer,
  add column has_audio boolean,
  add column pixel_format text,
  add column container text,
  add column probe jsonb;
