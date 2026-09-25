# fca-nsm-api

Barebones client and HTTP endpoint for the FCA's National Storage Mechanism
(NSM) search API. Extracted from
[RNS_Update](https://github.com/TomHyde10/RNS_Update)'s `lib/fetchReports.js`,
keeping the default company list, the category filter and the cache
(in memory, or optionally in Postgres). Digest emails, push notifications,
RSS/ICS feeds, keyword search and the frontend were left out.

The NSM search endpoint (`https://api.data.fca.org.uk/search?index=nsm-search`)
is undocumented and reverse-engineered from a captured browser request. It
could change or start blocking non-browser traffic without notice. No API
key is required.

## Run

```
npm start   # HTTP server on PORT (default 3000)
npm test    # unit tests, NSM mocked
```

Needs Node 18+. The only package is `pg`, and only for the optional
Postgres cache (see below). `npm install --omit=optional` skips it.

### `GET /api/reports`

Query params (all optional):

- `leis` - comma-separated list of 20-character LEIs (ISO 17442). Invalid
  entries are silently dropped. If none are given (or none are valid), the
  companies in `leis.json` are used.
- `days` - how many days back to search. Default `7`, clamped to `1..365`.
- `categories` - comma-separated filing categories, matched exactly
  (case-insensitive) against the NSM item's `type`, for example
  `Net Asset Value(s)`. Default:
  `Half-year Financial Report,Annual Financial Report`.

Example:

```
curl 'http://localhost:3000/api/reports?leis=549300UC0QPP7Y0W8056&days=30&categories=Half-year%20Financial%20Report'
```

Response:

```json
{
  "leis": ["549300UC0QPP7Y0W8056"],
  "dateFrom": "2026-08-26T00:00:00.000Z",
  "days": 30,
  "categories": ["Half-year Financial Report"],
  "scanned": 41,
  "count": 1,
  "reports": [
    {
      "lei": "549300UC0QPP7Y0W8056",
      "company": "Fidelity European Trust plc",
      "title": "Half-year Financial Report",
      "category": "Half-year Financial Report",
      "publishedAt": "2026-09-08T00:00:00.000Z",
      "url": "https://data.fca.org.uk/artefacts/...",
      "id": "...",
      "raw": { "...": "the untouched NSM item" }
    }
  ],
  "cachedLeis": ["549300UC0QPP7Y0W8056"]
}
```

`scanned` counts every filing in the window before the category filter.
`failedLeis`, `cachedLeis` and `deltaLeis` only appear when non-empty.
`cacheBackend` is `memory` or `postgres`.

## `leis.json`

The default company list: an array of `{ "lei": "...", "name": "..." }`.
`name` is optional; when it is blank, the company name from the NSM response
is used. Look up an LEI at search.gleif.org.

The 21 entries came from RNS_Update's `config/watchlist.js`, which was built
by resolving a list of ISINs. Only two are confirmed (Edinburgh Investment
Trust and Fidelity European Trust), and both sat one position later than
expected in the original ISIN order. The list may be misaligned, so check
it before relying on it.

## Caching

Each LEI's raw NSM results are cached for `NSM_CACHE_TTL_MINUTES`
(default `10`; `0` disables it). The cache key is the LEI alone, because the
day window and categories are applied afterwards, so one cached fetch serves
any category filter and any shorter window.

- Fresh entry, deep enough: served from the cache (`cachedLeis`).
- Stale entry, deep enough: NSM is asked only for filings since the last
  fetch, and those are merged in (`deltaLeis`). If that request fails, the
  stale entry is served.
- No entry, or the new window needs more results than were cached: full
  fetch.

By default the cache lives in the process, so it is lost on restart and not
shared between instances.

### Optional: Postgres cache

Set `DATABASE_URL` and the cache is stored in Postgres instead, so it
survives restarts (useful on hosts that sleep, such as Render's free tier)
and is shared between instances. The `nsm_cache` table is created on first
use. Needs the `pg` package (`npm install` includes it).

```
DATABASE_URL=postgres://user:password@host:5432/dbname npm start
```

- The database's TLS certificate is verified by default. If your provider
  uses a CA that isn't in Node's default store, set `DATABASE_SSL_CA` to its
  certificate (PEM text; literal `\n`s are converted to newlines).
- `DATABASE_SSL_VERIFY=false` skips verification. The connection is still
  encrypted but open to interception, so use it only as a last resort.
- An `sslmode` in `DATABASE_URL` overrides both, for example
  `?sslmode=disable` for a local database without TLS.
- If the database is unreachable or `pg` is missing, requests still succeed
  but go uncached. The error is logged for each LEI on each request.

`npm test` skips the Postgres test unless `TEST_DATABASE_URL` is set:

```
TEST_DATABASE_URL='postgres://postgres@localhost:5432/postgres?sslmode=disable' npm test
```

It writes and then deletes one row with a test-only LEI.

## Use as a library

```js
const { fetchReports } = require('./nsm');

const { status, body } = await fetchReports({
  leis: '549300UC0QPP7Y0W8056',
  days: 30,
  categories: ['Net Asset Value(s)'],
});
```
