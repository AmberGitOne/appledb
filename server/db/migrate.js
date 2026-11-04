'use strict';
/**
 * Migration runner.
 *
 *   node server/db/migrate.js            apply the schema if not applied yet
 *   node server/db/migrate.js --fresh    drop everything and rebuild
 *
 * The schema lives in schema.sql as one authoritative script. A
 * `schema_migrations` table records which scripts have run so a second
 * invocation is a no-op rather than an error.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, configure, tableExists } = require('./index');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const FRESH = process.argv.includes('--fresh');

async function ensureMigrationsTable() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

async function dropEverything() {
  await db.pragma('foreign_keys = OFF');

  const drop = async (type, keyword) => {
    const rows = await db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = ? AND name NOT LIKE 'sqlite_%'`
      )
      .all(type);
    for (const { name } of rows) {
      await db.exec(`DROP ${keyword} IF EXISTS "${name}"`);
    }
  };

  // Order matters: triggers and views reference tables.
  await drop('trigger', 'TRIGGER');
  await drop('view', 'VIEW');
  await drop('index', 'INDEX');
  await drop('table', 'TABLE');

  await db.pragma('foreign_keys = ON');
  console.log('  dropped all existing objects');
}

async function run() {
  await configure();

  const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
  const checksum = crypto.createHash('sha256').update(sql).digest('hex').slice(0, 16);

  if (FRESH) {
    console.log('Migrating (fresh rebuild)...');
    await dropEverything();
  } else {
    console.log('Migrating...');
  }

  await ensureMigrationsTable();

  const already = await db
    .prepare('SELECT checksum FROM schema_migrations WHERE name = ?')
    .get('schema.sql');

  if (already && already.checksum === checksum && (await tableExists('tickets'))) {
    console.log('  schema.sql already applied (checksum ' + checksum + ') - nothing to do');
    console.log('  run with --fresh to rebuild from scratch');
    return;
  }

  if (already && already.checksum !== checksum) {
    console.error(
      '\n  schema.sql changed since it was applied.\n' +
        '  Re-run with --fresh to rebuild (this erases data):\n' +
        '    npm run reset\n'
    );
    process.exitCode = 1;
    return;
  }

  // The script is applied statement by statement rather than inside one
  // transaction: it opens with a PRAGMA, which a transaction would ignore,
  // and a remote database would reject the mixture anyway. The checksum row
  // below is only written once the whole script succeeded, so a half-applied
  // schema is never recorded as done - the next run simply tries again.
  await db.exec(sql);
  await db.prepare(
    'INSERT OR REPLACE INTO schema_migrations (name, checksum) VALUES (?, ?)'
  ).run('schema.sql', checksum);

  const counts = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM sqlite_master WHERE type='table'  AND name NOT LIKE 'sqlite_%') AS tables,
         (SELECT COUNT(*) FROM sqlite_master WHERE type='index'  AND name NOT LIKE 'sqlite_%') AS indexes,
         (SELECT COUNT(*) FROM sqlite_master WHERE type='view')   AS views,
         (SELECT COUNT(*) FROM sqlite_master WHERE type='trigger') AS triggers`
    )
    .get();

  console.log(
    `  applied: ${counts.tables} tables, ${counts.indexes} indexes, ` +
      `${counts.views} views, ${counts.triggers} triggers`
  );
  console.log('  next: npm run seed');
}

if (require.main === module) {
  run()
    .then(() => db.close())
    .catch((err) => {
      console.error('Migration failed:', err.message);
      process.exit(1);
    });
}

module.exports = { run };
