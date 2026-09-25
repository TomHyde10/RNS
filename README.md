# fca-nsm-api

Barebones client and HTTP endpoint for the FCA's National Storage Mechanism
(NSM) search API. Extracted from [RNS_Update](https://github.com/TomHyde10/RNS_Update)'s `lib/fetchReports.js`,
with the watchlist config, Postgres/in-memory caching, digest emails, push
notifications, and RSS/ICS feeds stripped out - just the NSM lookup itself.

The NSM search endpoint (`https://api.data.fca.org.uk/search?index=nsm-search`)
is undocumented and reverse-engineered from a captured browser request. It
could change or start blocking non-browser traffic without notice. No API
key is required.

## Run

```
npm start
```

Starts a plain HTTP server (no dependencies) on `PORT` (default `3000`).

### `GET /api/reports`

Query params:

- `leis` (required) - comma-separated list of 20-character LEIs (ISO 17442).
  Invalid entries are silently dropped; if none remain, returns `400`.
- `days` (optional, default `7`) - how many days back to search, clamped to
  `1..365`.

Example:

```
curl 'http://localhost:3000/api/reports?leis=213800LXOWSQI2IPGO66&days=14'
```

Response:

```json
{
  "leis": ["213800LXOWSQI2IPGO66"],
  "dateFrom": "2026-09-11T00:00:00.000Z",
  "days": 14,
  "count": 2,
  "reports": [
    {
      "lei": "213800LXOWSQI2IPGO66",
      "company": "Example Trust plc",
      "title": "Half-year Financial Report",
      "category": "Half-year Financial Report",
      "publishedAt": "2026-09-15T00:00:00.000Z",
      "url": "https://data.fca.org.uk/artefacts/...",
      "id": "...",
      "raw": { "...": "the untouched NSM item" }
    }
  ]
}
```

## Use as a library

```js
const { fetchReports } = require('./nsm');

const { status, body } = await fetchReports({ leis: '213800LXOWSQI2IPGO66', days: 30 });
```

`fetchReports` makes one NSM request per LEI, filters results to items
published within the requested window, and normalises each hit. It does not
cache - every call hits the NSM API directly.
