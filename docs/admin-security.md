# Administrator authentication

Administrator RPCs require the existing confirmed owner identity, a signed `aal2`
session claim, and a currently verified Auth MFA factor. The frontend also checks
`admin_security_status` before mounting administrator panels. Ordinary approved
reader access is independent of administrator MFA.

The owner opens Admin, explicitly enrolls a TOTP authenticator, scans the QR code
locally and enters its current six-digit code. Later password-only sessions must
complete an MFA challenge. Codes and enrollment secrets are not persisted by the
application. Only unfinished factors can be removed through the setup screen.

Before replacing a device, use the authenticator's secure backup/transfer process.
For a lost device, an authorized Supabase project operator must verify the owner's
identity out of band, use Auth user management to revoke the lost factor, and
revoke the affected sessions before fresh enrollment. Never disable the database
MFA guard or change the owner email to work around recovery. The operator's
Supabase organization account should have its own MFA and recovery controls.

Leaked-password protection is an Auth project setting, not a SQL migration.
Enable **Prevent use of leaked passwords** in Authentication → Sign In / Providers
→ Email. It rejects known compromised passwords during signup/password changes;
it does not prove that any existing user's password is compromised or replace MFA.
Do not log passwords or submit real credentials in test fixtures.

`paper_ready` uses an empty search path. Its stored callers explicitly contain the
same readiness expression, preserving planner visibility and the existing partial
indexes. Any future change to readiness semantics must update the helper and all
expanded callers together and check behavior and plans.
