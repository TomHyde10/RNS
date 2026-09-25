// Barebones client for the FCA's National Storage Mechanism (NSM) search
// API - given one or more LEIs, returns the regulatory filings of the
// chosen categories published for them in the last N days. Falls back to
// the companies in leis.json when no LEIs are given. Results are cached per
// LEI, in memory or optionally in Postgres (see the cache section below).
//
// This is an undocumented, reverse-engineered endpoint (no public API
// docs, no key), confirmed by capturing a real browser request/response
// from data.fca.org.uk's NSM search page. It could change or start
// blocking non-browser traffic without notice. company_lei filters
// server-side (confirmed: every hit for a given LEI is that one company),
// so one request per LEI is enough.

const defaultCompanies = require('./leis.json');
const cacheStore = require('./cacheStore');

const NSM_SEARCH_URL = 'https://api.data.fca.org.uk/search?index=nsm-search';
const NSM_ARTEFACT_BASE = 'https://data.fca.org.uk/artefacts/';

const DEFAULT_WINDOW_DAYS = 7;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

// Scales with the requested window since a real capture showed roughly
// 1-2 filings/day for one company - 15/day gives comfortable headroom for
// a busier issuer, capped so a long window can't request an enormous page.
const RESULTS_PER_DAY_ESTIMATE = 15;
const MAX_RESULTS_PER_LEI = 1000;

// Confirmed exact values of the `type` field for the two report kinds
// matched by default (e.g. a Fidelity European Trust filing came back with
// "type": "Half-year Financial Report"). Used when no categories are given.
const DEFAULT_CATEGORIES = ['Half-year Financial Report', 'Annual Financial Report'];

// Standard LEI (ISO 17442) format: 20 alphanumeric characters.
const LEI_RE = /^[A-Z0-9]{20}$/;

// Mimics a browser request in case the server enforces Origin/Referer
// server-side as informal bot filtering.
const BROWSER_LIKE_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/plain, */*',
  origin: 'https://data.fca.org.uk',
  referer: 'https://data.fca.org.uk/',
  'user-agent': 'Mozilla/5.0 (compatible; fca-nsm-api/1.0)',
};

function parseLeis(leis) {
  const raw = Array.isArray(leis) ? leis : String(leis || '').split(',');
  const cleaned = raw.map((s) => String(s).trim().toUpperCase()).filter((s) => LEI_RE.test(s));
  return [...new Set(cleaned)];
}

function parseWindowDays(days) {
  const n = parseInt(days, 10);
  if (Number.isNaN(n)) return DEFAULT_WINDOW_DAYS;
  return Math.min(Math.max(n, MIN_WINDOW_DAYS), MAX_WINDOW_DAYS);
}

// Accepts a comma-separated string or array of category names to match
// against the NSM item's `type` field (case-insensitive, exact match - real
// values are things like "Half-year Financial Report" and "Net Asset
// Value(s)"). Falls back to DEFAULT_CATEGORIES when nothing usable is
// given, so an empty value doesn't silently return everything. Returns the
// original-cased list (for the response) and a lowercased set (for
// matching).
function parseCategories(categories) {
  const raw = Array.isArray(categories) ? categories : String(categories || '').split(',');
  const cleaned = raw.map((s) => String(s).trim()).filter(Boolean);
  const list = cleaned.length ? cleaned : [...DEFAULT_CATEGORIES];
  return { list, set: new Set(list.map((s) => s.toLowerCase())) };
}

function resultsPerLei(windowDays) {
  return Math.min(MAX_RESULTS_PER_LEI, Math.max(100, windowDays * RESULTS_PER_DAY_ESTIMATE));
}

// Matches the exact timestamp format seen in a real captured request (no
// fractional seconds - a live request with a millisecond-bearing "to"
// returned a 404 "Unable to search the data", so this strips them to
// match the one shape known to work).
function toIsoNoMillis(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function dateCutoff(windowDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - windowDays);
  return d;
}

function documentUrlOf(item) {
  return item.download_link ? `${NSM_ARTEFACT_BASE}${item.download_link}` : item.html_link || null;
}

function normalise(item) {
  const known = defaultCompanies.find((c) => c.lei === item.lei);
  return {
    lei: item.lei || null,
    company: (known && known.name) || item.company || item.lei || null,
    title: item.headline || item.type || '(untitled)',
    category: item.type || null,
    publishedAt: item.publication_date || item.document_date || item.submitted_date || null,
    url: documentUrlOf(item),
    id: item.disclosure_id || item._id || null,
    raw: item,
  };
}

// company_lei's value array format (["", "<LEI>", "disclose_org",
// "related_org"]) and dateCriteria's `from: null` are captured verbatim
// from a real browser request - this is an undocumented API and deviating
// from the one known-working shape is what caused a live 404 (see
// toIsoNoMillis above). The last-N-days window is instead enforced
// afterwards, client-side, against the dates already present on each item.
function buildRequestBody(lei, toIso, size) {
  return {
    from: 0,
    size,
    sort: 'submitted_date',
    sortorder: 'desc',
    criteriaObj: {
      criteria: [
        { name: 'company_lei', value: ['', lei, 'disclose_org', 'related_org'] },
        { name: 'latest_flag', value: 'Y' },
      ],
      dateCriteria: [
        { name: 'publication_date', value: { from: null, to: toIso } },
        { name: 'submitted_date', value: { from: null, to: toIso } },
      ],
    },
  };
}

async function fetchForLei(lei, toIso, size) {
  let response;
  try {
    response = await fetch(NSM_SEARCH_URL, {
      method: 'POST',
      headers: BROWSER_LIKE_HEADERS,
      body: JSON.stringify(buildRequestBody(lei, toIso, size)),
    });
  } catch (err) {
    return { lei, error: `Failed to reach the NSM search API: ${err}` };
  }

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    return { lei, error: `NSM search API returned ${response.status}`, details: details.slice(0, 2000) };
  }

  const data = await response.json();
  const hits = data.hits && Array.isArray(data.hits.hits) ? data.hits.hits : [];
  return { lei, items: hits.map((h) => h._source).filter(Boolean) };
}

// --- Cache ---
//
// Each LEI's raw NSM items are cached for CACHE_TTL_MS. Keyed
// only by LEI, not by window/categories, because both filters are applied
// afterwards against the same raw item list - so an entry fetched with a
// large enough `size` covers any smaller later request for that LEI. A
// request needing a bigger `size` than what's cached (a wider window) is a
// miss and gets a full re-fetch. A stale entry that is still deep enough
// only asks NSM for what's new since it was fetched (a "delta" fetch) and
// merges that in.
//
// With DATABASE_URL set the cache is kept in Postgres (cacheStore.js), so
// it survives a restart and is shared between instances. Without it, the
// cache is an in-memory Map, lost on restart.
const parsedCacheTtlMinutes = parseInt(process.env.NSM_CACHE_TTL_MINUTES, 10);
// Explicit 0 disables caching; anything else invalid/unset means 10.
const CACHE_TTL_MINUTES = Number.isNaN(parsedCacheTtlMinutes) ? 10 : parsedCacheTtlMinutes;
const CACHE_TTL_MS = CACHE_TTL_MINUTES * 60 * 1000;
const memoryCache = new Map(); // lei -> { items, size, fetchedAt } - used only when cacheStore is disabled

function isFresh(cached, size) {
  return cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS && cached.size >= size;
}

// A stable identity for a filing across two NSM responses - most items
// carry a disclosure_id/_id; the rest fall back to a composite key.
function itemKey(item) {
  return item.disclosure_id || item._id || `${item.lei}|${item.type}|${item.publication_date || item.document_date || item.submitted_date}|${item.headline}`;
}

// Combines a cached page with a freshly fetched one - the fresh copy wins
// on a collision (a filing may have been amended since), anything only the
// old page knows about is kept, and the result is sorted newest-first to
// match what a full fetch would return.
function mergeItems(oldItems, freshItems) {
  const byKey = new Map();
  for (const item of oldItems) byKey.set(itemKey(item), item);
  for (const item of freshItems) byKey.set(itemKey(item), item);
  const dateOf = (item) => new Date(item.submitted_date || item.publication_date || item.document_date || 0).getTime();
  return [...byKey.values()].sort((a, b) => dateOf(b) - dateOf(a));
}

// How many of the newest items a delta fetch asks for, given how long it's
// been since the cache entry was fetched.
function catchUpSize(elapsedMs) {
  const elapsedDays = Math.max(1, Math.ceil(elapsedMs / (24 * 60 * 60 * 1000)));
  return resultsPerLei(elapsedDays);
}

// A database error shouldn't take down report loading - a failed read is
// treated as a cold cache and a failed write is just logged.
async function readCache(lei) {
  if (!cacheStore.enabled) return memoryCache.get(lei) || null;
  try {
    return await cacheStore.getCached(lei);
  } catch (err) {
    console.error(`nsm_cache read failed for ${lei}:`, err.message || err);
    return null;
  }
}

async function writeCache(lei, items, size) {
  if (!cacheStore.enabled) {
    memoryCache.set(lei, { items, size, fetchedAt: Date.now() });
    return;
  }
  try {
    await cacheStore.setCached(lei, items, size);
  } catch (err) {
    console.error(`nsm_cache write failed for ${lei}:`, err.message || err);
  }
}

async function fetchForLeiCached(lei, toIso, size) {
  const cached = await readCache(lei);
  if (isFresh(cached, size)) return { lei, items: cached.items, cached: true };

  if (cached && cached.size >= size) {
    const delta = await fetchForLei(lei, toIso, catchUpSize(Date.now() - cached.fetchedAt));
    // A failed catch-up still leaves slightly stale but usable data.
    if (delta.error) return { lei, items: cached.items, cached: true };
    const merged = mergeItems(cached.items, delta.items);
    await writeCache(lei, merged, Math.max(cached.size, size));
    return { lei, items: merged, delta: true };
  }

  const result = await fetchForLei(lei, toIso, size);
  if (!result.error) await writeCache(lei, result.items, size);
  return result;
}

// Clears the in-memory cache only - the Postgres table is left alone.
function clearCache() {
  memoryCache.clear();
}

async function fetchReports({ leis, days, categories } = {}) {
  const requestedLeis = parseLeis(leis);
  const effectiveLeis = requestedLeis.length ? requestedLeis : parseLeis(defaultCompanies.map((c) => c.lei));
  if (effectiveLeis.length === 0) {
    return { status: 400, body: { error: 'No valid LEIs given and leis.json has none (leis=<LEI1>,<LEI2>,...).' } };
  }

  const windowDays = parseWindowDays(days);
  const { list: categoryList, set: categorySet } = parseCategories(categories);
  const cutoff = dateCutoff(windowDays);
  const toIso = toIsoNoMillis(new Date());
  const size = resultsPerLei(windowDays);

  const results = await Promise.all(effectiveLeis.map((lei) => fetchForLeiCached(lei, toIso, size)));

  const failed = results.filter((r) => r.error);
  if (failed.length === results.length) {
    return { status: 502, body: { error: 'NSM search API request failed for every LEI.', details: failed } };
  }

  const itemDate = (item) => {
    const raw = item.publication_date || item.document_date || item.submitted_date;
    return raw ? new Date(raw) : null;
  };
  const matchesCategory = (item) => typeof item.type === 'string' && categorySet.has(item.type.toLowerCase());

  const allItems = results.flatMap((r) => r.items || []);
  const withinWindow = allItems.filter((item) => {
    const d = itemDate(item);
    return d && !Number.isNaN(d.getTime()) && d >= cutoff;
  });
  const reports = withinWindow.filter(matchesCategory).map(normalise);

  const cachedLeis = results.filter((r) => r.cached).map((r) => r.lei);
  const deltaLeis = results.filter((r) => r.delta).map((r) => r.lei);

  return {
    status: 200,
    body: {
      leis: effectiveLeis,
      dateFrom: cutoff.toISOString(),
      days: windowDays,
      categories: categoryList,
      scanned: withinWindow.length,
      count: reports.length,
      reports,
      failedLeis: failed.length ? failed : undefined,
      cachedLeis: cachedLeis.length ? cachedLeis : undefined,
      deltaLeis: deltaLeis.length ? deltaLeis : undefined,
      cacheBackend: cacheStore.enabled ? 'postgres' : 'memory',
    },
  };
}

module.exports = {
  fetchReports,
  parseLeis,
  parseWindowDays,
  parseCategories,
  clearCache,
  LEI_RE,
  MAX_WINDOW_DAYS,
  DEFAULT_CATEGORIES,
  // Exported for unit testing only.
  mergeItems,
  itemKey,
  catchUpSize,
};
