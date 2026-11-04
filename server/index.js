'use strict';
/**
 * Apple Globalcare CRM - HTTP server.
 * Serves the REST API under /api and the browser app from /web.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { db, configure, DB_DESCRIPTION, tableExists } = require('./db');
const { warmup } = require('./lib/resource');
const { authenticate, REQUIRE_AUTH } = require('./middleware/auth');
const { HttpError } = require('./lib/http');

const app = express();
const PORT = Number(process.env.PORT) || 4000;
const WEB_DIR = path.join(__dirname, '..', 'web');

app.set('trust proxy', 1);
app.use(compression());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '25mb' }));   // the state payload is large
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(':method :url :status :response-time[0]ms', {
    skip: (req) => req.url.startsWith('/assets') || req.url.endsWith('.css'),
  }));
}

// ---- health (no auth) -------------------------------------------------
app.get('/api/health', async (req, res, next) => {
  try {
  const counts = await db.prepare(`
    SELECT (SELECT COUNT(*) FROM tickets)   AS tickets,
           (SELECT COUNT(*) FROM orders)    AS orders,
           (SELECT COUNT(*) FROM cases)     AS cases,
           (SELECT COUNT(*) FROM suppliers) AS suppliers,
           (SELECT COUNT(*) FROM audit_log) AS audit_entries
  `).get();
  res.json({
    status: 'ok',
    database: DB_DESCRIPTION,
    requireAuth: REQUIRE_AUTH,
    counts,
    uptimeSeconds: Math.round(process.uptime()),
  });
  } catch (err) { next(err); }
});

// ---- API --------------------------------------------------------------
app.use('/api', authenticate, require('./routes'));

app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route for ${req.method} ${req.originalUrl}` });
});

// ---- browser app ------------------------------------------------------
// In development the browser's heuristic caching happily serves a stale
// app.css or mobile.css after an edit, which looks like the change simply
// did not work. Revalidate every time locally; cache normally in production.
const IS_DEV = process.env.NODE_ENV !== 'production';
app.use(express.static(WEB_DIR, {
  extensions: ['html'],
  etag: true,
  lastModified: true,
  maxAge: IS_DEV ? 0 : '1h',
  setHeaders(res) {
    if (IS_DEV) res.setHeader('Cache-Control', 'no-cache');
  },
}));
app.get('*', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

// ---- errors -----------------------------------------------------------
app.use((err, req, res, _next) => {
  const status = err instanceof HttpError ? err.status : (err.status || 500);
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || 'Something went wrong',
    ...(err.details ? { details: err.details } : {}),
  });
});

// ---- one-time async init ----------------------------------------------
/**
 * Connect, check the schema and resolve the resource column whitelists.
 *
 * Memoised, because on a serverless host every request may arrive at a warm
 * instance that has already done this, and the ones that arrive during a
 * cold start must all wait on the same promise rather than racing.
 */
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await configure();
      await warmup();
    })();
  }
  return readyPromise;
}

// ---- start ------------------------------------------------------------
async function start() {
  await configure();

  if (!(await tableExists('tickets'))) {
    console.error('\n  The database has no schema yet. Run:\n');
    console.error('    npm run setup\n');
    process.exit(1);
  }
  const { n: ticketCount } = await db.prepare('SELECT COUNT(*) AS n FROM tickets').get();
  if (ticketCount === 0) {
    console.warn('  Warning: the database is empty. Run `npm run seed` to load the demo data.');
  }

  // Resolve every resource's column whitelist now, so a bad table name is a
  // startup failure rather than a surprise on the first request that hits it.
  await ready();

  const server = app.listen(PORT, () => {
    console.log('');
    console.log('  Apple Globalcare CRM');
    console.log(`  app      http://localhost:${PORT}`);
    console.log(`  api      http://localhost:${PORT}/api/health`);
    console.log(`  database ${DB_DESCRIPTION}`);
    console.log(`  auth     ${REQUIRE_AUTH ? 'required' : 'open (set REQUIRE_AUTH=true to enforce)'}`);
    console.log('');
  });

  const shutdown = (signal) => {
    console.log(`\n  ${signal} received, closing...`);
    server.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

if (require.main === module) {
  start().catch((err) => {
    console.error('Failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = { app, start, ready };
