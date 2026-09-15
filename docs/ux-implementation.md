# Reader workspace implementation

Implemented the sixteen accepted UX review items for clinical daily reading and research discovery equally. Originals and figures stay in the private archive. Only citations, derived summaries, source locations and reader activity are stored in the application database.

| Item | Implementation | Verification status |
|---|---|---|
| I01 entry/recovery | Existing email sign-in, configured Kakao entry, live public preview, return route and chunk recovery | Auth unit tests, browser entry, real provider authorization page |
| I02 discovery | Bounded search; PMID/DOI, date/journal/study/summary/integrity filters, pagination and visible Korean expansion | PostgreSQL cases and desktop/mobile workflows |
| I03 paper detail | Permanent paper route, return navigation, share/cite | Browser workflows and safe link tests |
| I04 evidence | Stable source locations, numeric citation checks, hash-bound viewer navigation | Python/PostgreSQL validation, real article inference and viewer scenarios |
| I05 status/access | Separate citation, summary, access, unavailable and retry states | Viewer and admin browser scenarios |
| I06 recommendations | Server selection and a bounded five-paper response, profile preferences and legacy alerts | PostgreSQL and daily-reading browser tests |
| I07 integrity | PubMed linked notices, bounded refresh, preserved known notices and manual summary review | Python notice tests, database review and invalidation tests |
| I08 reader state | Save, reading state, opinion and reading position remain independent | Database isolation and mobile interactions |
| I09 study details | Design, population, sample, intervention, comparator, follow-up, outcome, limitations and cited Q&A | Real inference and paper-detail tests |
| I10 mobile | Shared responsive reader, readable text, share/cite and touch controls | 16 routes at 320/390/1440 px; automated WCAG checks |
| I11 research reuse | Compare two to five papers, CSV/RIS/BibTeX, private and project notes | Export escaping and browser comparison tests |
| I12 reporting | Categorized issue intake, open-issue deduplication, admin triage and reader-visible resolution | PostgreSQL permissions and browser resolution flow |
| I13 notifications | Saved query criteria, new-result counts, enable/disable and acknowledgement | Database and saved-search browser tests |
| I14 admin | Metadata/original/summary stages, accurate denominators, database capacity, separate retries and issue queues | Mobile admin scenarios |
| I15 offline/resume | Explicit device summaries, app shell cache, account isolation, removal, logout purge and reading position | Production-build offline reload/sign-out, allowlist and auth race tests |
| I16 projects/sharing | Topics, suggestions, invitations/acceptance, reader/editor roles and revocation | PostgreSQL role isolation and project browser workflows |

Validation: 114 Python tests, 47 frontend unit tests and 20 browser scenarios passed locally (the full 19-scenario run plus the welcome-to-preview regression). Isolated PostgreSQL tests cover all migrations through 021, including existing upgrades, role isolation, summary publication and source changes. Browser fixtures contain synthetic data and never request production data; the offline scenario uses the production build and service worker.

A real original produced a validated three-line summary, three Q&A pairs and fifteen source references through the existing model endpoint. The publication payload contains derived fields only. Live database verification is required alongside fixtures. Migration 021 enables readiness checks to use the acquired-original index and adds a bounded integrity-refresh index.

Existing summaries remain readable while the background queue regenerates extended fields and claim references. Missing fields are shown as unprocessed. A re-summary of unchanged text does not clear a correction review flag. Email signup/recovery and digest delivery remain conditional on verified email configuration; saved-query notifications work inside the app. Project membership does not grant original access. Device storage contains explicitly saved summaries and metadata only, capped at 100 papers; it is not a server credential.


## Daily reading interaction revision (2026-09-15)

The generic card feed added navigation to the common reading task. Daily reading now opens the first complete three-line summary immediately, with a compact queue beside it on desktop and an optional queue on mobile. Reading five papers requires four next-paper selections without returning to a listing. This is an interaction count verified with synthetic browser scenarios, not a measured improvement in reading time or comprehension.

Save, explicit read state, original access and previous/next controls stay visible while content scrolls. Study design, population and sample size follow the summary; full details and Q&A expand in place. Recommendation reasons and literal whole-word highlights are restored through the existing validation. Date and selected PMID survive visits to research detail and the original viewer. J/K or left/right keys navigate papers without capturing typing or interactive controls. Mobile queue focus returns to the selected article, with Escape dismissal.

Research detail, notes, projects, exports, integrity notices and source-location links remain available. Daily and research views share summary/study rendering. Private reading state is cached only in the mounted day/user session; adjacent detail requests are deduplicated. Slow saves, undo across article changes, and request failures are tested separately. Inference, storage boundaries and database contracts are unchanged by this UI revision.

Validation for this revision: 47 frontend unit tests, production build, and 29 browser scenarios, including 16 routes at 320/390/1440 px, sequential reading, Q&A, undo, slow saves, error recovery, literal AI matching, original access and offline restoration. The local installed Chrome network emulator reports navigator.onLine=true after an offline navigation; the unchanged production offline scenario passes on installed Edge. CI uses its pinned Playwright Chromium.

Design rationale: frequently needed information belongs on the primary screen ([NN/g: Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/)). Before claiming general UX superiority, compare completion, errors, backtracking and satisfaction for both daily reading and research tasks ([NN/g: Usability Metrics](https://www.nngroup.com/articles/usability-metrics/)). Passing functional/accessibility tests alone does not establish that superiority.
