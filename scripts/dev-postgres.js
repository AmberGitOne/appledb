'use strict';
/**
 * A local Postgres for development, so you do not need a cloud database to
 * run the app on your own machine.
 *
 *   npm run db:local
 *
 * It downloads nothing at run time - the server binaries come with the
 * embedded-postgres devDependency - and keeps its data under data/pgdata,
 * which is gitignored. Leave it running in its own terminal; the app reads
 * DATABASE_URL and will find it at the address printed below.
 *
 * First time:
 *   npm run db:local        (in one terminal, leave it running)
 *   npm run setup           (in another - creates the schema and demo data)
 *   npm start
 */

const path = require('path');
const fs = require('fs');
const EmbeddedPostgres = require('embedded-postgres').default;

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data', 'pgdata');
const PORT = Number(process.env.PGPORT) || 5433;
const USER = 'crm';
const PASSWORD = 'crm';
const DATABASE = 'crm';

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
});

(async () => {
  if (!fs.existsSync(DATA_DIR)) {
    console.log('  creating the cluster in data/pgdata (first run only)...');
    await pg.initialise();
  }

  await pg.start();

  // UTF8 has to be stated outright. On Windows the cluster's default
  // follows the OS locale, which is usually WIN1252, and the demo data has
  // characters with no representation there - the seed fails halfway with
  // a confusing encoding error. template0 is required to override it.
  const { Client } = require('pg');
  const admin = new Client({
    host: '127.0.0.1', port: PORT, user: USER, password: PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
  if (!exists.rowCount) {
    await admin.query(
      `CREATE DATABASE "${DATABASE}" WITH ENCODING 'UTF8' TEMPLATE template0 ` +
      `LC_COLLATE 'C' LC_CTYPE 'C'`
    );
    console.log('  created database ' + DATABASE + ' (UTF8)');
  }
  await admin.end();

  const url = `postgres://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DATABASE}`;
  console.log('');
  console.log('  Local Postgres is up.');
  console.log(`  DATABASE_URL=${url}`);
  console.log('');
  console.log('  Put that line in .env, then in another terminal:');
  console.log('    npm run setup     (first time only)');
  console.log('    npm start');
  console.log('');
  console.log('  Ctrl-C here stops the database.');

  const stop = async () => {
    console.log('\n  stopping postgres...');
    try { await pg.stop(); } catch (_) { /* already down */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((err) => {
  console.error('Could not start the local database:', err.message);
  process.exit(1);
});
