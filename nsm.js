// Barebones client for the FCA's National Storage Mechanism (NSM) search
// API - given one or more LEIs, returns the regulatory filings published
// for them in the last N days. No caching, no watchlist config, no
// digest/push/subscriptions - just the search call and its response shape.
//
// This is an undocumented, reverse-engineered endpoint (no public API
// docs, no key), confirmed by capturing a real browser request/response
// from data.fca.org.uk's NSM search page. It could change or start
// blocking non-browser traffic without notice. company_lei filters
// server-side (confirmed: every hit for a given LEI is that one company),
// so one request per LEI is enough.

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
  return {
    lei: item.lei || null,
    company: item.company || item.lei || null,
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

async function fetchReports({ leis, days } = {}) {
  const effectiveLeis = parseLeis(leis);
  if (effectiveLeis.length === 0) {
    return { status: 400, body: { error: 'At least one valid 20-character LEI is required (leis=<LEI1>,<LEI2>,...).' } };
  }

  const windowDays = parseWindowDays(days);
  const cutoff = dateCutoff(windowDays);
  const toIso = toIsoNoMillis(new Date());
  const size = resultsPerLei(windowDays);

  const results = await Promise.all(effectiveLeis.map((lei) => fetchForLei(lei, toIso, size)));

  const failed = results.filter((r) => r.error);
  if (failed.length === results.length) {
    return { status: 502, body: { error: 'NSM search API request failed for every LEI.', details: failed } };
  }

  const itemDate = (item) => {
    const raw = item.publication_date || item.document_date || item.submitted_date;
    return raw ? new Date(raw) : null;
  };

  const allItems = results.flatMap((r) => r.items || []);
  const withinWindow = allItems.filter((item) => {
    const d = itemDate(item);
    return d && !Number.isNaN(d.getTime()) && d >= cutoff;
  });

  const reports = withinWindow.map(normalise);

  return {
    status: 200,
    body: {
      leis: effectiveLeis,
      dateFrom: cutoff.toISOString(),
      days: windowDays,
      count: reports.length,
      reports,
      failedLeis: failed.length ? failed : undefined,
    },
  };
}

module.exports = {
  fetchReports,
  parseLeis,
  parseWindowDays,
  LEI_RE,
  MAX_WINDOW_DAYS,
};
