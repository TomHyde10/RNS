// Runs the cache against a real Postgres, only when TEST_DATABASE_URL is
// set (e.g. TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres?sslmode=disable).
// Uses its own table rows keyed by a test-only LEI and removes them after.
const { it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const skip = TEST_DATABASE_URL ? false : 'TEST_DATABASE_URL not set';
if (TEST_DATABASE_URL) process.env.DATABASE_URL = TEST_DATABASE_URL;

const LEI = 'TESTTESTTESTTESTTEST';
const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const originalFetch = global.fetch;
let calls = 0;
let pool;

before(async () => {
  if (skip) return;
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await pool.query('DELETE FROM nsm_cache WHERE lei = $1', [LEI]).catch(() => {});
  global.fetch = async () => {
    calls += 1;
    const hit = { lei: LEI, disclosure_id: 'pg1', type: 'Annual Financial Report', publication_date: recent, submitted_date: recent };
    return { ok: true, json: async () => ({ hits: { hits: [{ _source: hit }] } }) };
  };
});

after(async () => {
  global.fetch = originalFetch;
  if (skip) return;
  await pool.query('DELETE FROM nsm_cache WHERE lei = $1', [LEI]);
  await pool.end();
  // nsm.js's own pool would otherwise keep the process alive.
  process.exit(0);
});

it('stores results in Postgres and serves the next request from there', { skip }, async () => {
  const { fetchReports, clearCache } = require('../nsm');

  const first = await fetchReports({ leis: LEI });
  assert.equal(first.body.cacheBackend, 'postgres');
  assert.equal(first.body.count, 1);

  const { rows } = await pool.query('SELECT size, jsonb_array_length(items) AS n FROM nsm_cache WHERE lei = $1', [LEI]);
  assert.deepEqual(rows, [{ size: 105, n: 1 }]);

  clearCache(); // in-memory only - proves the hit comes from the table
  const second = await fetchReports({ leis: LEI });
  assert.equal(calls, 1);
  assert.deepEqual(second.body.cachedLeis, [LEI]);
  assert.equal(second.body.count, 1);
});
