CREATE TABLE public.welcome_message_candidates (
  server_id TEXT NOT NULL REFERENCES public.servers(guild_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  member_snapshots JSONB NOT NULL DEFAULT '{}',
  snapshots_complete BOOLEAN NOT NULL DEFAULT FALSE,
  verification_attempted BOOLEAN NOT NULL DEFAULT FALSE,
  recipient_id TEXT,
  verified_edited_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (server_id, message_id)
);
CREATE INDEX welcome_message_candidates_source_time_idx
  ON public.welcome_message_candidates(server_id, channel_id, bot_id, created_at);
ALTER TABLE public.welcome_message_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.welcome_message_candidates FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.welcome_message_candidates FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON public.welcome_message_candidates FROM authenticated;
  END IF;
END $$;
