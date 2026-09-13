-- Use the original email_digest column consistently in the app and sender.
BEGIN;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS digest_email_address TEXT DEFAULT '';

-- Preserve preferences if the untracked legacy column was added in production.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'digest_email'
  ) THEN
    EXECUTE 'UPDATE public.profiles SET email_digest = coalesce(digest_email, email_digest)';
  END IF;
END;
$$;
UPDATE public.profiles SET email_digest = false WHERE name = '[DELETED]';
COMMIT;
