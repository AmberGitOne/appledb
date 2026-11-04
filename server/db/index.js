'use strict';
/**
 * Database connection (PostgreSQL).
 *
 * One pg Pool for the process. Postgres is the only backend now: a
 * serverless host has no writable disk, so the file-based SQLite this app
 * started on could not follow it there.
 *
 *   POSTGRES_URL or DATABASE_URL   postgres://user:pass@host/db
 *
 * The API is deliberately the shape the call sites already use -
 * prepare(sql) then .get/.all/.run - so the 200-odd queries did not have to
 * be rewritten a second time. Two translations make that possible: `?`
 * placeholders become `$1, $2, ...`, and bigint columns come back as
 * numbers rather than strings.
 */

const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool, Client, types } = require('pg');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

/**
 * COUNT() and SUM() are int8/numeric, and node-postgres hands those back as
 * strings so that values beyond 2^53 survive. Every such number here is a
 * row count or a small sum, and the app compares and adds them as numbers -
 * `counts.tickets === 41` would quietly be false against "41".
 */
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));    // int8
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));  // numeric

const CONNECTION_URL =
  (process.env.POSTGRES_URL || process.env.DATABASE_URL || '').trim();

if (!CONNECTION_URL) {
  throw new Error(
    'No database configured. Set POSTGRES_URL (or DATABASE_URL) to a ' +
    'Postgres connection string. On Vercel this comes from the Postgres ' +
    'integration; locally, copy it from the project settings into .env.'
  );
}

/**
 * A direct connection string, when the provider gives one.
 *
 * Neon's pooled endpoint - the hostname with `-pooler` in it, which is the
 * one to serve traffic through - is PgBouncer in transaction mode, and that
 * does not keep a client on the same server connection between statements.
 * Anything session-scoped is therefore unreliable through it, including the
 * advisory lock the first-boot path depends on: the lock and its unlock can
 * land on different backends. Neon and the Vercel integration both publish
 * the direct string next to the pooled one, under these names.
 */
const DIRECT_URL = (
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING ||
  CONNECTION_URL
).trim();

/**
 * TLS, and whether to verify the server's certificate.
 *
 * A local test server has no TLS at all, so it is detected per URL rather
 * than once - the pooled and direct strings can differ.
 *
 * Skipping verification leaves the connection open to interception: TLS
 * without it only hides the traffic from a passive observer, not from
 * anything sitting in the path. Hosted Postgres - Neon, Render, Supabase -
 * presents a certificate from a public CA, which Node's bundled roots
 * verify without help. DB_SSL_NO_VERIFY exists for a provider that only
 * offers a self-signed certificate, and it has to be asked for.
 */
const SSL_NO_VERIFY = String(process.env.DB_SSL_NO_VERIFY).toLowerCase() === 'true';

function sslFor(url) {
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) return false;
  return { rejectUnauthorized: !SSL_NO_VERIFY };
}

const pool = new Pool({
  connectionString: CONNECTION_URL,
  ssl: sslFor(CONNECTION_URL),
  // A serverless instance handles one request at a time and every instance
  // holds its own pool, so a larger one only exhausts the server's slots.
  max: process.env.VERCEL ? 1 : 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('idle postgres client error:', err.message));

/** Something short to print in logs and /api/health - never the password. */
const DB_DESCRIPTION = (() => {
  try {
    const u = new URL(CONNECTION_URL);
    return u.host + u.pathname;
  } catch (_) {
    return 'postgres';
  }
})();

// ---------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------

/**
 * The transaction currently in scope, if any.
 *
 * A Postgres transaction belongs to one connection, so every statement
 * inside it has to go to that same client rather than to the pool.
 * AsyncLocalStorage carries it implicitly, which is what lets the call
 * sites keep using the shared `db`; two concurrent saves cannot land in
 * each other's transaction the way a module-level variable would allow.
 */
const txStore = new AsyncLocalStorage();

/** The transaction's client, or the pool. */
function conn() {
  return txStore.getStore() || pool;
}

// ---------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------

/**
 * `?` -> `$1, $2, ...`
 *
 * The queries were written for SQLite. Renumbering all of them by hand
 * would have been a second sweep over 200 call sites for no behavioural
 * gain, so the placeholders are translated here. Question marks inside
 * string literals are left alone: `WHERE note LIKE '%?%'` must not be
 * turned into a parameter.
 */
function toPg(sql) {
  if (!sql.includes('?')) return sql;
  let out = '';
  let n = 0;
  let quote = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; out += c; continue; }
    if (c === '?') { out += '$' + ++n; continue; }
    out += c;
  }
  return out;
}

/** better-sqlite3 accepted .get(a, b) and .get([a, b]) alike. */
function toArgs(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function prepare(sql) {
  const text = toPg(sql);
  return {
    sql: text,

    async get(...params) {
      const res = await conn().query(text, toArgs(params));
      return res.rows.length ? res.rows[0] : undefined;
    },

    async all(...params) {
      const res = await conn().query(text, toArgs(params));
      return res.rows;
    },

    async run(...params) {
      const res = await conn().query(text, toArgs(params));
      // Postgres has no "last insert id"; a statement that needs one says
      // RETURNING, and the first returned column is it.
      let lastInsertRowid;
      if (res.rows && res.rows.length) {
        const first = res.rows[0];
        const key = Object.keys(first)[0];
        if (key !== undefined) lastInsertRowid = first[key];
      }
      return { changes: res.rowCount, lastInsertRowid };
    },
  };
}

/** Run several statements separated by semicolons - schema.sql, mostly. */
async function exec(sql) {
  await conn().query(sql);
}

/**
 * Run fn inside a transaction; rolls back if it throws.
 *
 * Nesting joins the transaction already in scope rather than opening a
 * second one, which Postgres does not have.
 */
function transaction(fn) {
  return async (...args) => {
    if (txStore.getStore()) return fn(...args);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await txStore.run(client, () => fn(...args));
      await client.query('COMMIT');
      return out;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
      throw err;
    } finally {
      client.release();
    }
  };
}

const db = {
  prepare,
  exec,
  transaction,
  close: () => pool.end(),
};

// ---------------------------------------------------------------------
// connection setup
// ---------------------------------------------------------------------

/**
 * Check the connection and report what we reached.
 *
 * There is no PRAGMA setup to do here: Postgres enforces foreign keys
 * always and has no journal mode to choose. What is worth doing is failing
 * at startup on a bad connection string, rather than on whichever query
 * happens to run first.
 */
async function configure() {
  const res = await pool.query('SELECT current_database() AS db, version() AS v');
  if (process.env.NODE_ENV !== 'test') {
    const row = res.rows[0];
    console.log(`  connected to ${row.db} (${row.v.split(',')[0]})`);
  }
}

/**
 * Run fn while holding a cluster-wide lock, so only one process runs it.
 *
 * This exists for the first-boot schema load on a serverless host, where
 * several cold starts can arrive at once and each would otherwise try to
 * create the same tables. An advisory lock lives on its own connection and
 * is released when that connection closes, so a crashed instance cannot
 * leave the lock held - which is the failure a lock *table* would have.
 *
 * The connection is a standalone Client rather than one from the pool: the
 * pool holds a single connection on Vercel, and checking it out to wait on
 * the lock would leave fn with nothing to query through.
 */
async function withAdvisoryLock(key, fn) {
  const client = new Client({
    connectionString: DIRECT_URL,
    ssl: sslFor(DIRECT_URL),
  });
  await client.connect();
  try {
    // pg_advisory_xact_lock, not pg_advisory_lock: a transaction-scoped
    // lock survives a pooler, because the whole transaction is pinned to
    // one backend, and it is released by COMMIT or ROLLBACK - so it cannot
    // be stranded by an instance that dies holding it either.
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [key]);
    try {
      const out = await fn();
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

/** Does a table exist? Used by the migration runner and by startup. */
async function tableExists(name) {
  const res = await pool.query('SELECT to_regclass($1) IS NOT NULL AS present',
    ['public.' + name]);
  return !!res.rows[0].present;
}

module.exports = {
  db,
  pool,
  configure,
  transaction,
  tx: transaction,
  tableExists,
  withAdvisoryLock,
  DB_DESCRIPTION,
};
