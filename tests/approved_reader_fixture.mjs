// Existing regression fixtures represent already admitted readers. The separate
// membership suite deliberately omits this helper and tests pending-by-default.
export const approvedReaderFixture = `
CREATE FUNCTION auth.approve_existing_reader_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name='access_status') THEN
  EXECUTE 'UPDATE public.profiles SET access_status=''approved'' WHERE id=$1' USING NEW.id;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER zz_approved_reader_fixture AFTER INSERT ON auth.users
 FOR EACH ROW EXECUTE FUNCTION auth.approve_existing_reader_fixture();
`;
