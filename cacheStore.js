// Optional Postgres-backed store for nsm.js's cache, so cached NSM results
// survive a restart (e.g. a free-tier host spinning down and cold-starting,
// which would otherwise re-hit NSM for every LEI at once). Enabled only when
// DATABASE_URL is set; otherwise nsm.js uses its in-memory Map and this
// module never loads `pg`, so the package is only needed with a database.
const DATABASE_URL = process.env.DATABASE_URL;
const enabled = Boolean(DATABASE_URL);

let pool = null;
let schemaReady = null;

// The server's certificate is verified by default. DATABASE_SSL_CA (the
// provider's CA certificate as PEM text) trusts a CA that isn't in Node's
// default store. DATABASE_SSL_VERIFY=false is the last-resort opt-out:
// still encrypted, but anyone able to intercept the connection could
// impersonate the database and read or poison the cache. An `sslmode` in
// DATABASE_URL itself overrides all of this, since pg applies connection
// string params last.
function sslOptions() {
  if (process.env.DATABASE_SSL_VERIFY === 'false') return { rejectUnauthorized: false };
  const ca = process.env.DATABASE_SSL_CA;
  // A PEM pasted into a single-line env var usually carries literal "\n"s.
  return ca ? { ca: ca.replace(/\\n/g, '\n') } : { rejectUnauthorized: true };
}

function getPool() {
  if (!pool) {
    let Pool;
    try {
      ({ Pool } = require('pg'));
    } catch (err) {
      throw new Error('DATABASE_URL is set but the "pg" package is not installed - run `npm install pg`.');
    }
    pool = new Pool({ connectionString: DATABASE_URL, ssl: sslOptions() });
  }
  return pool;
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS nsm_cache (
        lei TEXT PRIMARY KEY,
        items JSONB NOT NULL,
        size INTEGER NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL
      )
    `).catch((err) => {
      // Let the next call retry instead of caching the failure forever.
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

async function getCached(lei) {
  await ensureSchema();
  const { rows } = await getPool().query('SELECT items, size, fetched_at FROM nsm_cache WHERE lei = $1', [lei]);
  if (rows.length === 0) return null;
  return { items: rows[0].items, size: rows[0].size, fetchedAt: new Date(rows[0].fetched_at).getTime() };
}

async function setCached(lei, items, size) {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO nsm_cache (lei, items, size, fetched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (lei) DO UPDATE SET items = $2, size = $3, fetched_at = NOW()`,
    [lei, JSON.stringify(items), size]
  );
}

module.exports = { enabled, getCached, setCached };
