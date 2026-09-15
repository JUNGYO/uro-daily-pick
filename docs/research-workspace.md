# Project research workspace

The existing reading, summaries, Q&A, search, collection and sharing screens remain the entry points. Open a project and choose **연구 정리** to organize a study worksheet and introduction/discussion material.

Personal library and project searches apply keywords to titles, identifiers, notes and tags before pagination. The notes tab also includes notes on papers that were never saved. Personal records stay private; project records follow the project's reader/editor permissions.

Research columns, extracted values, manual overrides, source references and writing topics are durable project records. Removing a paper from the collection list preserves this research work. Deleting the project removes its research records as stated in the confirmation. Replacing an original invalidates its extraction; completing a replacement never overwrites a manual value. Concurrent edits fail with a recoverable version conflict instead of silently overwriting another editor.

## Documents

The whole-project snapshot supplies DOCX, CSV, RIS and Google Docs. It includes the effective worksheet values, linked writing topics and project notes. Private reading notes are not silently included in shared output. Exports use all project references, independently of the current search or page. Broad worksheets are split into readable column bands in DOCX.

Google Docs is an explicit user action. The browser requests only `drive.file`, converts the DOCX into a new native Google document, and keeps the access token transient. It never replaces a previously exported writing document. Export history is private to its creator and also requires current project access; each entry records the source revision fingerprint. A lost create response is reconciled by the export ID rather than blindly repeating the upload.

Regular DOCX contains editable text, tables and source links. RIS supplies bibliographic import for Zotero. The separate Zotero transfer encoder remains disabled in the interface until a real Word or Google Docs plugin has passed Refresh, repeated-citation, bibliography and style-change checks. A source link is not presented as an active Zotero citation or as library synchronization.

## Deployment

1. Run Python, frontend, database and browser checks.
2. Apply migration `023_research_documents.sql` before publishing the web build. It is additive, backfills existing project references and installs scoped worker RPCs. The production preflight requires these contracts.
3. Update the existing literature release with the included research phase. Reuse the configured inference endpoint and local original store. Preserve the existing task principal, schedule and separate research environment.
4. Configure a Google OAuth web client with the service's exact JavaScript origin, `drive.file`, a public privacy-policy URL and the Drive API enabled. Set public Actions variable `GOOGLE_CLIENT_ID`; never put the OAuth client secret in the frontend.
5. Verify a real user can save/reopen a project, export a document and retrieve the corresponding private export history.

The worker reads verified local originals and submits only derived values, source location IDs and necessary metadata. Its own inference lock coordinates literature summarization and project extraction. Long jobs save local progress and resume across leases; invalid output retains a bounded retry policy. It does not call or modify the separate research control service.
