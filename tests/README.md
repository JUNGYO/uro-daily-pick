# Regression checks

Use Node 24 and Python 3.12. Tests do not contact production Supabase, Gemini, or Resend.

```sh
python -m pip install -r scripts/requirements-dev.txt
python -m unittest discover -s tests -v
cd frontend
npm ci
npm run check
npx playwright install chromium
npm run test:e2e
```

`npm run check` runs Vitest, isolated SQL regressions, and the Vite build/404 copy. `npm run format:check` checks source formatting. Windows can use an installed Chrome with `$env:PLAYWRIGHT_CHANNEL = 'chrome'`.

- UI tests cover auth races, signup confirmation, onboarding/settings persistence failures, collection failure, feedback failure, password mismatch, invalid JSON, dates, and pagination.
- Python tests cover pipeline failures, study classification, validated model output, full-text parsing, weekly digests, and immutable delivery retries.
- `node tests/test_migrations.mjs` applies all migrations to isolated PGlite PostgreSQL, mocks Supabase auth roles, and checks access control, atomic writes/rollback, private stores, and account deletion.
- Browser tests exercise the full application using `tests/fixtures/browser_api.js`, block external requests, audit ten pages at three viewport widths, and exercise mobile navigation and collections. Screenshots and failure traces are in ignored `frontend/test-results/`.

For manual review, build the frontend and run `node tests/browser_harness.mjs` from the repository root. Open `http://127.0.0.1:3101/uro-daily-pick/`. Scenarios: `?scenario=signed-out`, `empty`, `error`, `onboarding`, `admin`, `feedback-error`. Stop with Ctrl+C.

Real authentication redirects, publisher entitlement, verified email delivery, production migration history, and operational monitoring require staging checks. See `docs/service-readiness.md`.
