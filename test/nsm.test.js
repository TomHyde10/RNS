// Unit tests for nsm.js with global.fetch mocked - no real NSM requests.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchReports, parseCategories, clearCache, mergeItems, itemKey, catchUpSize, DEFAULT_CATEGORIES,
} = require('../nsm');
const defaultCompanies = require('../leis.json');

const LEI = 'AAAAAAAAAAAAAAAAAAAA';
const recent = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function item(overrides) {
  return { lei: LEI, company: 'Example plc', publication_date: recent(), submitted_date: recent(), ...overrides };
}

let calls;
let responder;
const originalFetch = global.fetch;

beforeEach(() => {
  clearCache();
  calls = [];
  responder = () => [];
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const lei = body.criteriaObj.criteria[0].value[1];
    calls.push({ lei, size: body.size });
    return { ok: true, json: async () => ({ hits: { hits: responder(lei).map((s) => ({ _source: s })) } }) };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('leis.json', () => {
  it('is a list of valid 20-character LEIs', () => {
    assert.ok(defaultCompanies.length > 0);
    for (const c of defaultCompanies) assert.match(c.lei, /^[A-Z0-9]{20}$/);
  });

  it('is used when no leis are given', async () => {
    const { status, body } = await fetchReports({});
    assert.equal(status, 200);
    assert.equal(body.leis.length, defaultCompanies.length);
    assert.equal(calls.length, defaultCompanies.length);
  });
});

describe('categories', () => {
  it('defaults to half-year and annual reports', () => {
    assert.deepEqual(parseCategories('').list, DEFAULT_CATEGORIES);
  });

  it('matches the item type exactly, ignoring case', async () => {
    responder = () => [
      item({ disclosure_id: '1', type: 'Half-year Financial Report' }),
      item({ disclosure_id: '2', type: 'Net Asset Value(s)' }),
      item({ disclosure_id: '3', type: 'Net Asset Value(s) - correction' }),
    ];
    const { body } = await fetchReports({ leis: LEI, categories: 'net asset value(s)' });
    assert.deepEqual(body.categories, ['net asset value(s)']);
    assert.deepEqual(body.reports.map((r) => r.id), ['2']);
    assert.equal(body.scanned, 3);
  });
});

describe('cache', () => {
  it('serves a repeat request from the cache', async () => {
    responder = () => [item({ disclosure_id: '1', type: 'Annual Financial Report' })];
    await fetchReports({ leis: LEI });
    const { body } = await fetchReports({ leis: LEI });
    assert.equal(calls.length, 1);
    assert.deepEqual(body.cachedLeis, [LEI]);
    assert.equal(body.count, 1);
  });

  it('re-fetches when a wider window needs a bigger page', async () => {
    await fetchReports({ leis: LEI, days: 7 });
    await fetchReports({ leis: LEI, days: 60 });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].size > calls[0].size);
  });

  it('does not cache a failed request', async () => {
    global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const failed = await fetchReports({ leis: LEI });
    assert.equal(failed.status, 502);
    global.fetch = async () => ({ ok: true, json: async () => ({ hits: { hits: [] } }) });
    const { body } = await fetchReports({ leis: LEI });
    assert.equal(body.cachedLeis, undefined);
  });
});

describe('cache helpers', () => {
  it('itemKey falls back to a composite key', () => {
    assert.equal(itemKey({ lei: 'L', type: 'T', publication_date: 'D', headline: 'H' }), 'L|T|D|H');
  });

  it('mergeItems keeps old items, prefers fresh ones, sorts newest-first', () => {
    const old = [
      { disclosure_id: '1', headline: 'old', submitted_date: '2026-01-01T00:00:00Z' },
      { disclosure_id: '0', submitted_date: '2025-12-01T00:00:00Z' },
    ];
    const fresh = [
      { disclosure_id: '1', headline: 'new', submitted_date: '2026-01-01T00:00:00Z' },
      { disclosure_id: '2', submitted_date: '2026-01-03T00:00:00Z' },
    ];
    const merged = mergeItems(old, fresh);
    assert.deepEqual(merged.map((i) => i.disclosure_id), ['2', '1', '0']);
    assert.equal(merged[1].headline, 'new');
  });

  it('catchUpSize floors at one day and caps at 1000', () => {
    assert.equal(catchUpSize(60 * 1000), 100);
    assert.equal(catchUpSize(200 * 24 * 60 * 60 * 1000), 1000);
  });
});
