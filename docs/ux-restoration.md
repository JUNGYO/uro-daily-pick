# Original workspace restoration

The comparison baseline is commit 2f73ebb (before the research workspace redesign). A redesign must preserve existing tasks, their entry points and saved data. The previous release retained several components in source but removed their main navigation entries or replaced their routes; that was a user-visible regression.

## Feature comparison

| Existing task or information | Restored or retained entry point | Focused improvement |
| --- | --- | --- |
| Five daily recommendations, selected row and date navigation | Original compact list beside the article on desktop; list first on mobile | Date picker and previous/next days; selected paper survives detail navigation |
| Study-type colors, journal, authors, publication date | Original list badges and article metadata | All original study types covered |
| Personalized reasons, matched terms and recommendation score | Why this paper chips and article metadata | Whole-word matching retained; score explicitly labeled as recommendation score |
| Clinical relevance and reading estimate | Article metadata | AI classification labeled; time estimate explicitly refers to the abstract |
| Full-text three-line summary | Visible summary in the article | Verified source requirement retained; source links remain attached to claims |
| Design, N, population, key finding and Q&A | Original Details & Q&A accordion | Available intervention, comparator, follow-up, outcomes and limitations added in the same section |
| Abstract and keyword highlighting | Directly visible below Details & Q&A | No extra abstract-expansion step |
| Previous/next, like/dislike, share, citation, original, Publisher and PubMed | Persistent article toolbar | Touch targets, keyboard access and action labels; save/read/opinion remain independent |
| Feedback undo and completion | Toolbar notification and reading completion | Undo remains bound to the initiating paper after navigation; only explicit read marks count as completed |
| Reading activity, annual reading count, likes and streak | Insights restored to primary navigation | Existing charts and their data sources retained |
| Activity heatmap, research topic visualization, study-type bars | Existing Research Insights screen | No replacement with a generic dashboard |
| Existing named collections, including legacy saved lists | Collections restored at its original route | Existing records reused; links to liked papers and collaboration added |
| Collection create, search, add/remove paper, delete confirmation | Original collection screen | Previously shared project links still redirect to their corresponding project |
| Research profile, interests, study preferences and journals | Existing Settings screen | Original controls retained |
| Topic alerts and account management | Existing Settings sections | Original controls retained |
| Admin, processing/storage progress and review tools | Existing administrator route and navigation | Existing permissions and implementations retained |
| Original text, figures, tables and source navigation | Article toolbar and full-text viewer | Current authentication, error recovery, download and logout clearing retained |

## Additional research workflows

Search and comparison, saved papers, notes, tags, citation export, offline summaries, saved searches, projects, invitations, shared notes, integrity notices and issue reporting remain available. Search, the library and projects have persistent secondary navigation; they do not replace Insights or Collections.

The classic collection route remains /collections. The collaboration workspace uses /projects. Older /collections?project=… links still work. Like feedback can be found in the library's **관심 있음** view, independently of saving.

## Verification and remaining analysis

Automated checks cover five-paper reading on desktop and small phones; list-first mobile navigation; browser Back and Escape; inline Q&A; save/read/opinion separation; cross-paper undo and slow-response races; failed-save and detail retry; whole-word highlighting; collection create/search/add/remove/delete; and access to original menus and research tools. The broader suite covers routes, accessibility, original figures, authentication and offline clearing.

These checks establish feature availability and interaction correctness, not user preference. Further changes should be evaluated against concrete tasks: locate an older liked paper; read five summaries; return from a source to the selected paper; and add a paper to an existing collection. Any proposed layout change must be compared with this restored version, with missing functions and extra steps treated as regressions. Do not infer improved usability from visual novelty or test pass counts.
