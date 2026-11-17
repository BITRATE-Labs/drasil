CREATE INDEX welcome_message_candidates_cap_idx
  ON public.welcome_message_candidates(server_id, created_at DESC, message_id DESC);
CREATE INDEX welcome_message_candidates_expiry_idx
  ON public.welcome_message_candidates(expires_at);
