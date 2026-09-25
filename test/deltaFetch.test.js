// The delta-fetch path needs an expired cache entry, so this file sets a 0
// TTL before loading nsm.js (node --test runs each file in its own process).
process.env.NSM_CACHE_TTL_MINUTES = '0';
delete process.env.DATABASE_URL;

const { it } = require('node:test');
const assert = require('node:assert/strict');
const { fetchReports } = require('../nsm');

const LEI = 'AAAAAAAAAAAAAAAAAAAA';
const at = (daysAgo) => new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
const annual = (id, daysAgo) => ({ lei: LEI, disclosure_id: id, type: 'Annual Financial Report', publication_date: at(daysAgo), submitted_date: at(daysAgo) });

it('a stale entry fetches only a catch-up page and merges it in', async (t) => {
  const pages = [[annual('old', 3)], [annual('new', 0)]];
  const sizes = [];
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async (url, opts) => {
    sizes.push(JSON.parse(opts.body).size);
    const hits = pages.shift().map((s) => ({ _source: s }));
    return { ok: true, json: async () => ({ hits: { hits } }) };
  };

  await fetchReports({ leis: LEI, days: 30 });
  const { body } = await fetchReports({ leis: LEI, days: 30 });

  assert.deepEqual(sizes, [450, 100]);
  assert.deepEqual(body.deltaLeis, [LEI]);
  assert.deepEqual(body.reports.map((r) => r.id), ['new', 'old']);
});
