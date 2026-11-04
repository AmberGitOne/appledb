'use strict';
/**
 * Vercel serverless entry point.
 *
 * Vercel runs this file as a function rather than running a server, so there
 * is no app.listen() here - the Express app is simply handed the request.
 *
 * ready() connects and resolves the resource metadata once per instance; a
 * cold start awaits it, a warm one gets the memoised promise back. Anything
 * it throws has to be answered here, because there is no process left to
 * crash into a restart the way a long-running server would.
 *
 * This host has a read-only filesystem, so a local database file is not an
 * option: POSTGRES_URL has to be set in the project's environment. The
 * Vercel Postgres integration sets it; server/db/index.js says so plainly
 * if it is missing.
 *
 * ready() also prepares an empty database on the first cold start, since
 * this host runs a function and never a start command - see AUTO_BOOTSTRAP
 * in server/index.js.
 */

const { app, ready } = require('../server');

module.exports = async (req, res) => {
  try {
    await ready();
  } catch (err) {
    console.error('startup failed:', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'The server could not reach its database.',
      detail: err.message,
    }));
    return;
  }
  return app(req, res);
};
