// Existing regression fixtures represent already admitted readers. The separate
// membership suite deliberately omits this helper and tests pending-by-default.
// Legacy suites represent a verified administrator session. Dedicated security
// tests explicitly remove factors / lower AAL to exercise the denial paths.
export const adminMfaFixture = `
CREATE TABLE auth.mfa_factors(user_id uuid,status text,factor_type text);
SELECT set_config('request.jwt.claims','{"aal":"aal2"}',false);
CREATE FUNCTION auth.enroll_admin_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF lower(NEW.email)='crazyslime@gmail.com' AND NEW.email_confirmed_at IS NOT NULL THEN
  INSERT INTO auth.mfa_factors VALUES(NEW.id,'verified','totp');
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER zz_admin_mfa_fixture AFTER INSERT ON auth.users
 FOR EACH ROW EXECUTE FUNCTION auth.enroll_admin_fixture();
`;
export const approvedReaderFixture = `${adminMfaFixture}
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
