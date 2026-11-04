'use strict';
/**
 * Application state.
 *
 *   GET  /api/state    assemble the whole app state from SQL
 *   PUT  /api/state    persist it back in a single transaction
 *   POST /api/state/reset   drop back to the seeded demo data
 *
 * This is what the browser app talks to in place of localStorage. The PUT
 * body is reconciled row by row (see lib/state.js), so a save issues only the
 * statements that correspond to real changes.
 */

const express = require('express');
const { db } = require('../db');
const { readState, writeState } = require('../lib/state');
const audit = require('../lib/audit');
const { wrap, badRequest } = require('../lib/http');
const { requires } = require('../middleware/auth');

const router = express.Router();

router.get('/', requires('tickets:read'), wrap(async (req, res) => {
  res.json({
    data: await readState(),
    meta: {
      user: req.user
        ? { id: req.user.id, name: req.user.name, role: req.user.role_name }
        : null,
      serverTime: new Date().toISOString(),
    },
  });
}));

router.put('/', requires('tickets:update'), wrap(async (req, res) => {
  const incoming = req.body && req.body.data ? req.body.data : req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw badRequest('Request body must be the state object, or { data: state }');
  }

  const started = Date.now();
  const changes = await writeState(incoming, req.user);
  const tables = Object.keys(changes);

  let rows = 0;
  for (const t of tables) {
    rows += changes[t].created + changes[t].updated + changes[t].deleted;
  }

  res.json({
    ok: true,
    changed: tables.length > 0,
    tables: changes,
    summary: { tables: tables.length, rows, ms: Date.now() - started },
  });
}));

router.post('/reset', requires('settings:update'), wrap(async (req, res) => {
  // Re-run the seeder in-process; it manages its own transaction.
  const { seed } = require('../db/seed');
  await db.transaction(seed)();
  await audit.record(req.user, 'reset', 'database', '', null,
    { at: new Date().toISOString() }, req.ip);
  res.json({ ok: true, data: await readState() });
}));

module.exports = router;
