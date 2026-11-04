'use strict';
/**
 * Database connection.
 *
 * One libSQL client for the whole process. libSQL speaks SQLite's dialect
 * either against a local file or against a Turso database over the network,
 * so the same code runs on a laptop, on Render's persistent disk, and on a
 * serverless host that has no writable filesystem at all.
 *
 *   TURSO_DATABASE_URL set  ->  libsql://... , needs TURSO_AUTH_TOKEN
 *   otherwise               ->  the local file named by DB_FILE
 *
 * Everything here is asynchronous, because the network client is. The shape
 * of the API is deliberately the one better-sqlite3 had - prepare(sql) then
 * .get/.all/.run - so the call sites read the same; they just await now.
 */

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { AsyncLocalStorage } = require('async_hooks');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const ROOT = path.join(__dirname, '..', '..');

const TURSO_URL = (process.env.TURSO_DATABASE_URL || '').trim();
const IS_REMOTE = TURSO_URL !== '';

/** The local file, or null when we are talking to Turso. */
const DB_FILE = IS_REMOTE
  ? null
  : path.resolve(ROOT, process.env.DB_FILE || './data/crm.db');

/** Something short to print in logs and /api/health. */
const DB_DESCRIPTION = IS_REMOTE
  ? TURSO_URL.replace(/^libsql:\/\//, '').split('?')[0]
  : path.basename(DB_FILE);

/**
 * A serverless host has a read-only filesystem and keeps nothing between
 * invocations, so a local file is not a database there - it would either
 * fail to open or silently vanish. Say which variable is missing instead.
 */
const SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
if (SERVERLESS && !IS_REMOTE) {
  throw new Error(
    'TURSO_DATABASE_URL is not set. This host cannot use a local SQLite ' +
    'file, because its filesystem is read-only and not shared between ' +
    'invocations. Set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.'
  );
}

if (!IS_REMOTE) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });

/**
 * Two entry points, deliberately.
 *
 * The default export of @libsql/client can open a local file, which it does
 * through a platform-specific native binary of about 8 MB. The /web entry is
 * plain fetch over the network and carries none of that - which is what a
 * serverless bundle wants, and it removes any chance of the .node file being
 * left out of the deployment. Remote connections never needed the native
 * code anyway.
 */
const { createClient } = IS_REMOTE
  ? require('@libsql/client/web')
  : require('@libsql/client');

const client = createClient(
  IS_REMOTE
    ? { url: TURSO_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: pathToFileURL(DB_FILE).href }
);

// ---------------------------------------------------------------------
// transactions
// ---------------------------------------------------------------------

/**
 * The transaction currently in scope, if any.
 *
 * better-sqlite3 was synchronous, so a transaction was simply "the next few
 * statements". Over a network client each statement has to be sent to the
 * transaction object itself, which would mean threading a handle through
 * every function that writes. AsyncLocalStorage carries it implicitly
 * instead, so the call sites keep using the shared `db`, and concurrent
 * requests cannot pick up each other's transaction the way a plain module
 * variable would allow.
 */
const txStore = new AsyncLocalStorage();

/** The transaction in scope, or the plain client. */
function conn() {
  return txStore.getStore() || client;
}

// ---------------------------------------------------------------------
// statements
// ---------------------------------------------------------------------

/**
 * libSQL rows are array-like as well as keyed, so they carry a `length` and
 * numeric indices that a plain row never had. Copying to an ordinary object
 * keeps spreads, Object.keys and JSON.stringify behaving the way the rest of
 * the codebase assumes.
 */
function plain(row) {
  const out = {};
  for (const key of Object.keys(row)) out[key] = row[key];
  return out;
}

/** better-sqlite3 accepted .get(a, b) and .get([a, b]) alike. */
function toArgs(params) {
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return params;
}

function prepare(sql) {
  return {
    sql,

    async get(...params) {
      const res = await conn().execute({ sql, args: toArgs(params) });
      return res.rows.length ? plain(res.rows[0]) : undefined;
    },

    async all(...params) {
      const res = await conn().execute({ sql, args: toArgs(params) });
      return res.rows.map(plain);
    },

    async run(...params) {
      const res = await conn().execute({ sql, args: toArgs(params) });
      return {
        changes: res.rowsAffected,
        // libSQL hands this back as a BigInt; every caller wants a number.
        lastInsertRowid: typeof res.lastInsertRowid === 'bigint'
          ? Number(res.lastInsertRowid)
          : res.lastInsertRowid,
      };
    },
  };
}

/** Run several statements separated by semicolons - schema.sql, mostly. */
async function exec(sql) {
  const active = txStore.getStore();
  if (active) {
    // executeMultiple does not exist on a transaction handle, and splitting
    // SQL correctly needs a parser. Nothing in this codebase needs it.
    throw new Error('db.exec() cannot be used inside a transaction');
  }
  await client.executeMultiple(sql);
}

/** PRAGMA, as a statement. Returns the rows, like better-sqlite3 did. */
async function pragma(statement) {
  const res = await conn().execute(`PRAGMA ${statement}`);
  return res.rows.map(plain);
}

/**
 * Run fn inside a transaction; rolls back if it throws.
 *
 * Nesting joins the transaction already in scope rather than opening a
 * second one, which libSQL would reject.
 */
function transaction(fn) {
  return async (...args) => {
    if (txStore.getStore()) return fn(...args);

    const tx = await client.transaction('write');
    try {
      const out = await txStore.run(tx, () => fn(...args));
      await tx.commit();
      return out;
    } catch (err) {
      try { await tx.rollback(); } catch (_) { /* already closed */ }
      throw err;
    }
  };
}

const db = {
  prepare,
  exec,
  pragma,
  transaction,
  close: () => client.close(),
};

// ---------------------------------------------------------------------
// connection setup
// ---------------------------------------------------------------------

/**
 * Apply the pragmas a local file needs, and check the one that matters
 * everywhere.
 *
 * WAL and synchronous are properties of a local file and mean nothing to a
 * remote database, so they are only sent in that case. Foreign keys are
 * different: the schema leans on ON DELETE CASCADE, and on Turso enforcement
 * is a property of the database rather than of this connection - so there it
 * is checked and reported rather than set.
 */
async function configure() {
  if (!IS_REMOTE) {
    // WAL lets readers run while a writer holds the lock - important once
    // the dashboard polls while someone is saving a ticket.
    await pragma('journal_mode = WAL');
    await pragma('synchronous = NORMAL');
    await pragma('busy_timeout = 5000');
    await pragma('foreign_keys = ON');
    return;
  }

  const [row] = await pragma('foreign_keys');
  if (!row || !row.foreign_keys) {
    console.warn(
      '  Warning: foreign keys are not enforced on this database.\n' +
      '  The schema relies on ON DELETE CASCADE, so deletes will leave\n' +
      '  orphaned rows. Enable foreign keys on the Turso database.'
    );
  }
}

/** Does a table exist? Used by the migration runner and by startup. */
async function tableExists(name) {
  const row = await prepare(
    "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(name);
  return !!row;
}

module.exports = {
  db,
  client,
  configure,
  transaction,
  tx: transaction,
  tableExists,
  DB_FILE,
  DB_DESCRIPTION,
  IS_REMOTE,
};
