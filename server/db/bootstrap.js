'use strict';
/**
 * Production boot step: make sure the database is usable, then get out of
 * the way.
 *
 *   node server/db/bootstrap.js && node server/index.js
 *
 * Runs on every deploy, so it has to be safe to run against a database that
 * already holds real records:
 *
 *   - applies the schema when it is missing
 *   - seeds the demo data ONLY when the database has no users, because a
 *     deployment with no users and REQUIRE_AUTH=true is one nobody can sign
 *     into
 *   - does nothing at all when data is already present
 *
 * Seeding truncates every data table, so the "no users" guard is what stops
 * a redeploy from wiping a live system.
 */

const { db, configure, tableExists, withAdvisoryLock, DB_DESCRIPTION } = require('./index');
const { assertSeedPasswordIsSafe } = require('../lib/demo');

async function hasRows(table) {
  if (!(await tableExists(table))) return false;
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return row.n > 0;
}

async function main() {
  await configure();
  console.log(`  database: ${DB_DESCRIPTION}`);

  if (!(await tableExists('tickets')) || !(await tableExists('users'))) {
    console.log('  no schema found - creating it');
    await require('./migrate').run();
  } else {
    // Keeps an existing deployment current when schema.sql moves forward.
    await require('./migrate').run();
  }

  if (await hasRows('users')) {
    const counts = await db.prepare(`
      SELECT (SELECT COUNT(*) FROM users)   AS users,
             (SELECT COUNT(*) FROM tickets) AS tickets,
             (SELECT COUNT(*) FROM orders)  AS orders
    `).get();
    console.log(
      `  existing data found (${counts.users} users, ${counts.tickets} tickets, ` +
      `${counts.orders} orders) - leaving it untouched`
    );
    return;
  }

  console.log('  database has no users - loading the demo dataset');
  assertSeedPasswordIsSafe();
  const { seed } = require('./seed');
  await db.transaction(seed)();
}

/**
 * The same thing, for a host with no deploy step of its own.
 *
 * Vercel runs a function, not a start command, so there is nowhere to put
 * `node server/db/bootstrap.js`. The first cold start does it instead.
 *
 * Two things make that safe. The fast path is two cheap queries - if the
 * schema is there and has users, this returns immediately and never touches
 * the migration runner, so it costs almost nothing on later cold starts.
 * And the slow path runs under an advisory lock, because a deploy's first
 * burst of traffic can cold-start several instances at once and each would
 * otherwise create the same tables.
 *
 * Schema changes after the first deploy are still a deliberate act: this
 * only migrates a database that has no users yet. Run `npm run migrate`
 * against POSTGRES_URL when schema.sql moves forward.
 *
 * Returns true if it did any work.
 */
const BOOTSTRAP_LOCK = 724301;

/**
 * Round trips in a migrate + seed, measured: 150.8s of first boot over a
 * 205ms link is ~735 sequential statements. It is latency, not work - the
 * same boot takes about two seconds against a database in the same region.
 */
const BOOTSTRAP_ROUND_TRIPS = 735;

/** How long the first request may reasonably spend. Under maxDuration. */
const BOOTSTRAP_BUDGET_MS = Number(process.env.BOOTSTRAP_BUDGET_MS) || 20000;

/**
 * Is the database close enough to prepare inside one request?
 *
 * A serverless function is killed at maxDuration. Seeding runs in a
 * transaction, so a kill rolls the whole thing back, and the next request
 * starts over and is killed at the same point - an invisible loop that
 * never converges and never explains itself. Whether that happens is
 * decided almost entirely by the round trip to the database, so measure it
 * and refuse up front rather than discovering it 60 seconds in.
 */
async function bootstrapFeasible() {
  const started = Date.now();
  await db.prepare('SELECT 1 AS n').get();
  const rtt = Math.max(Date.now() - started, 1);
  const estimateMs = rtt * BOOTSTRAP_ROUND_TRIPS;
  return { rtt, estimateMs, ok: estimateMs <= BOOTSTRAP_BUDGET_MS };
}


async function ensureDatabase() {
  if (await hasRows('users')) return false;

  return withAdvisoryLock(BOOTSTRAP_LOCK, async () => {
    // Whoever held the lock first may have just done all of this.
    if (await hasRows('users')) return false;

    assertSeedPasswordIsSafe();

    const { rtt, estimateMs, ok } = await bootstrapFeasible();
    if (!ok) {
      throw new Error(
        `This database is ${rtt}ms away, so preparing it would take about ` +
        `${Math.round(estimateMs / 1000)}s - longer than a serverless ` +
        `function is allowed to run, and a request killed partway rolls the ` +
        `whole thing back and retries forever. Either host the database in ` +
        `the same region as the function, or load the schema once yourself ` +
        `against the direct (non-pooled) connection string:

` +
        `    npm run setup

` +
        `Raise BOOTSTRAP_BUDGET_MS past ${BOOTSTRAP_BUDGET_MS} only if ` +
        `maxDuration in vercel.json allows it.`
      );
    }

    console.log(`  first boot: preparing the database (${rtt}ms away)`);
    await require('./migrate').run();
    const { seed } = require('./seed');
    await db.transaction(seed)();
    console.log('  first boot: done');
    return true;
  });
}

if (require.main === module) {
  main()
    .then(() => db.close())
    .catch((err) => {
      console.error('Bootstrap failed:', err.message);
      process.exit(1);
    });
}

module.exports = { main, ensureDatabase };
