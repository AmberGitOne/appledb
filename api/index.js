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
 * This host has a read-only filesystem, so DB_FILE is not an option:
 * TURSO_DATABASE_URL and TURSO_AUTH_TOKEN have to be set in the project's
 * environment. server/db/index.js says so plainly if they are missing.
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
