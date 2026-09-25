# Rebuild guide: fca-nsm-api

Read with [HANDOVER.md](HANDOVER.md). The target platform was not specified, so the mapping below shows a .NET column and a Power Automate column as examples.

## Requirements

**Must**

1. Accept a list of LEIs, a look-back window in days and a list of categories. Every input is optional (`nsm.js:253-264`).
2. Validate LEIs against `^[A-Z0-9]{20}$` after trimming and upper-casing. Remove duplicates. Drop invalid ones without an error (`nsm.js:36, 48-52`).
3. If no valid LEIs are given, use the default list (currently `leis.json`) (`nsm.js:255`).
4. `days`: default 7, clamped to 1–365 (`nsm.js:20-22, 54-58`).
5. `categories`: default `Half-year Financial Report` and `Annual Financial Report`. Exact match, ignoring case, against the NSM `type` field (`nsm.js:33, 67-72, 277`).
6. For each LEI, send one POST to the NSM search API using the exact body in `nsm.js:116-133`. Timestamps are UTC ISO with no milliseconds (`nsm.js:82-84`). Include the headers in `nsm.js:40-46`.
7. Page size per LEI: `min(1000, max(100, days × 15))` (`nsm.js:74-76`).
8. Read items from `hits.hits[]._source` (`nsm.js:153-154`).
9. Keep items whose date (`publication_date` → `document_date` → `submitted_date`) is on or after `now − days`. Drop items with no valid date (`nsm.js:273-283`).
10. Map each kept item to the output fields in HANDOVER.md (`nsm.js:96-108`).
11. Return 200 with the summary fields, 400 if there are no LEIs at all, and 502 only if every LEI failed. On partial failure, return 200 with `failedLeis` (`nsm.js:256-304`).
12. Cache raw items per LEI with a configurable TTL (default 10 minutes). Follow the fresh / catch-up / full-fetch rules and the merge rules (`nsm.js:157-246`).
13. A cache failure must not fail the request. Log it and carry on without the cache (`nsm.js:206-228`).

**Should** (these fix gaps in the current code)

14. Handle invalid JSON and network errors per LEI so they never crash the service (fixes `nsm.js:152`, `server.js:13`).
15. Add a timeout to each NSM call (none today).
16. Limit how many NSM calls run at once (today all run in parallel).
17. Warn when a result page is full (`items == size`), because older items may be missing.
18. Keep secrets such as the database connection string in the platform's secret store.
19. Decide what TTL 0 should mean and record the decision (HANDOVER.md, open question 6).

## Component mapping

| This repo | Role | .NET example | Power Automate example |
|---|---|---|---|
| `server.js` | HTTP GET endpoint | ASP.NET Core minimal API or Azure Function (HTTP trigger) | "When an HTTP request is received" trigger + Response action |
| `nsm.js` `parse*` functions | Input validation | Validation or binding class | Compose / Filter array + expressions |
| `leis.json` | Default companies | appsettings, a database table or blob storage | SharePoint list or Dataverse table |
| `nsm.js` `fetchForLei` | Call NSM | `HttpClient` via `IHttpClientFactory`, with Polly timeout and retry | HTTP action (Premium connector) inside Apply to each (concurrency on) |
| `Promise.all` (`nsm.js:266`) | Parallel calls | `Task.WhenAll` + `SemaphoreSlim` | Apply to each with concurrency control |
| Date window and category filter | Filtering | LINQ `Where` | Filter array |
| `normalise` | Output mapping | DTO record | Select action |
| In-memory `Map` | Cache | `IMemoryCache` | n/a. Use a table, or skip caching. |
| `cacheStore.js` + `nsm_cache` | Shared cache | `IDistributedCache` (SQL or Redis), or EF Core table with the same columns | Dataverse or SharePoint row per LEI (large JSON may exceed column limits: **UNVERIFIED**) |
| `mergeItems` / `itemKey` | Catch-up merge | Dictionary keyed by `itemKey`, then sort | Hard to do in a flow. Consider a full fetch every time. |
| Env vars | Config | `IOptions<T>` + Key Vault | Environment variables + Key Vault connector |
| `test/*.test.js` | Tests | xUnit + mocked `HttpMessageHandler` | Manual test runs with fixed inputs |
| (none) | Schedule | Timer-triggered function, if needed | Recurrence trigger, if needed |

## Acceptance tests

NSM should be mocked. "Recent" means dated 1 day ago. Tests 1–10 come from the existing tests (`test/*.test.js`); the rest come from reading the code.

| # | Input | Mock NSM returns | Expected |
|---|---|---|---|
| 1 | no params | `[]` for each LEI | 200. `leis` = all 21 from `leis.json`. 21 NSM calls. (`test/nsm.test.js:45-50`) |
| 2 | `categories=` (empty) | n/a | Categories = the two defaults (`test/nsm.test.js:54-56`) |
| 3 | `leis=AAAAAAAAAAAAAAAAAAAA&categories=net asset value(s)` | 3 recent items typed `Half-year Financial Report`, `Net Asset Value(s)`, `Net Asset Value(s) - correction` | `reports` has only the 2nd item. `scanned`=3. `categories`=`["net asset value(s)"]` (`test/nsm.test.js:58-68`) |
| 4 | Same LEI requested twice within the TTL | 1 recent Annual report | 1 NSM call in total. 2nd response has `cachedLeis=[LEI]` and `count=1` (`test/nsm.test.js:72-79`) |
| 5 | `days=7`, then `days=60` | `[]` | 2 NSM calls. 2nd page size larger (105 → 900) (`test/nsm.test.js:81-86`) |
| 6 | NSM returns HTTP 500, then OK | 500, then `[]` | 1st: 502. 2nd: no `cachedLeis` (failed calls are not cached) (`test/nsm.test.js:88-95`) |
| 7 | TTL=0. `days=30` twice | 1st: item `old` from 3 days ago. 2nd: item `new` from today | Page sizes `[450, 100]`. `deltaLeis=[LEI]`. Report ids `["new","old"]` (`test/deltaFetch.test.js`) |
| 8 | Merge: old `{1:"old"}, {0}`; fresh `{1:"new"}, {2}` | n/a | Order `2, 1, 0`. Item 1 has headline `new` (`test/nsm.test.js:103-115`) |
| 9 | Item with no id: `lei=L, type=T, publication_date=D, headline=H` | n/a | Key `L\|T\|D\|H` (`test/nsm.test.js:99-101`) |
| 10 | Catch-up after 1 minute; after 200 days | n/a | Page size 100; page size 1000 (`test/nsm.test.js:117-120`) |
| 11 | `leis=bad,549300uc0qpp7y0w8056,549300UC0QPP7Y0W8056` | `[]` | `leis=["549300UC0QPP7Y0W8056"]` (upper-cased, duplicate removed, `bad` dropped) |
| 12 | `days=0` / `days=9999` / `days=abc` | n/a | `days` = 1 / 365 / 7 |
| 13 | 2 LEIs: one returns 500, one OK | OK LEI returns 1 recent Annual report | 200. `count=1`. `failedLeis` has 1 entry with `error: "NSM search API returned 500"` |
| 14 | 1 LEI | 1 Annual report dated 10 days ago; `days=7` | `scanned=0`, `count=0` |
| 15 | 1 LEI | Item with `download_link="x.pdf"` | `url="https://data.fca.org.uk/artefacts/x.pdf"` |
| 16 | LEI `549300UC0QPP7Y0W8056` | Item with `company="Other"` | `company="Fidelity European Trust plc"` (the `leis.json` name wins) |
| 17 | `GET /other` or `POST /api/reports` | n/a | 404 `{"error":"Not found"}` |
| 18 | 1 LEI | HTTP 200 with a body that is not JSON | **Rebuild:** 502 or a `failedLeis` entry; service stays up. (Current code: throws, see HANDOVER.md limitations.) |
| 19 | Postgres configured; same LEI twice, memory cache cleared in between | 1 recent Annual report | 1 NSM call. Row in `nsm_cache` with `size=105`. 2nd response has `cachedLeis` (`test/postgresCache.test.js`) |

Also run one **live smoke test** against the real NSM API with a confirmed LEI (for example `549300UC0QPP7Y0W8056` and `days=365`). Check that the response returns 200 and has the expected shape. Expected content is **UNVERIFIED**.

## Suggested build order

1. **Check the NSM call by hand** (Postman or curl) using the body in `nsm.js:116-133`. If it no longer works, stop and escalate. Everything else depends on it.
2. Confirm the default LEI list with the business (HANDOVER.md, open question 2).
3. Build input parsing and validation (requirements 1–5) and acceptance tests 2, 11 and 12.
4. Build the NSM client for one LEI, with a timeout and error handling (requirements 6–8, 14–15).
5. Add parallel calls for several LEIs with a concurrency limit, and partial-failure handling (requirements 11 and 16; tests 1, 6, 13).
6. Add the date window, category filter and output mapping (requirements 9–10; tests 3, 14–16).
7. Expose the endpoint (test 17).
8. Add the cache: fresh hits first, then full re-fetch, then catch-up merge (requirement 12; tests 4–10). Skip it if call volume doesn't justify it.
9. Add the shared or persistent cache store if you run more than one instance (requirement 13; test 19).
10. Add config and secrets, logging and monitoring. Then run the live smoke test.
11. Add a schedule or downstream consumer, once the open question about who uses the output is answered.
