-- How a media file came to be (media/Media.ts, MediaOwner.source): a
-- dropped attachment, an agent's own upload, a URL it fetched, a browser's
-- direct upload, a call to the API. The row said whose a file is and what
-- it is, never why it exists — an app could not tell a dropped screenshot
-- from a finished render, so it could not clean up one and keep the other.
-- Null for rows from before.
alter table phantom_agent_sdk.media add column source text;
