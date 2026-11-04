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

const { db, configure, tableExists, DB_DESCRIPTION } = require('./index');

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
    try {
      await require('./migrate').run();
    } catch (err) {
      console.error('  migration failed:', err.message);
      process.exit(1);
    }
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
  const { seed } = require('./seed');
  await db.transaction(seed)();
}

if (require.main === module) {
  main()
    .then(() => db.close())
    .catch((err) => {
      console.error('Bootstrap failed:', err.message);
      process.exit(1);
    });
}

module.exports = { main };
