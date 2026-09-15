-- Retire the public summary demo. No reader, catalog, or worker contract changes.
BEGIN;
DROP FUNCTION IF EXISTS public.preview_papers();
COMMIT;
