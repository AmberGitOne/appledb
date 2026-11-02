'use strict';
/**
 * End-to-end smoke test.
 *
 *   npm test                 (expects the server on PORT, default 4000)
 *
 * Drives the real HTTP API the way the browser does, then reads the SQLite
 * file directly to confirm the data actually landed in the right tables.
 * Restores the database to the seeded state when it finishes.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const BASE = `http://localhost:${process.env.PORT || 4000}`;
const { db } = require('../server/db');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name + (detail ? ` -> ${detail}` : ''));
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

async function api(method, path, body) {
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, body: json, raw: text };
}

const one = (sql, ...p) => db.prepare(sql).get(...p);
const many = (sql, ...p) => db.prepare(sql).all(...p);

async function main() {
  console.log(`\nSmoke test against ${BASE}\n`);

  // ---- reachability --------------------------------------------------
  let health;
  try {
    health = await api('GET', '/api/health');
  } catch (err) {
    console.error(`\n  Cannot reach ${BASE} - is the server running? (npm start)\n`);
    process.exit(1);
  }
  check('health endpoint responds', health.status === 200);
  check('health reports a database', !!health.body?.database);

  console.log('\n-- read paths --');

  const state = await api('GET', '/api/state');
  check('GET /api/state returns 200', state.status === 200);
  const S = state.body?.data;
  check('state carries all 33 collections', S && Object.keys(S).length === 33,
    S ? Object.keys(S).length : 'no data');
  check('state includes tickets', Array.isArray(S?.tickets) && S.tickets.length > 0);
  check('tickets carry their threads',
    S?.tickets?.some((t) => Array.isArray(t.thread) && t.thread.length > 0));
  check('suppliers carry their certificates',
    S?.suppliers?.some((x) => Array.isArray(x.certs) && x.certs.length > 0));
  check('qa batches carry their checks',
    S?.qa?.some((q) => Array.isArray(q.checks) && q.checks.length === 8));

  const list = await api('GET', '/api/tickets?folder=inbox&priority=Urgent&limit=5');
  check('ticket filter returns only urgent inbox rows',
    list.status === 200 && list.body.data.every((t) => t.folder === 'inbox' && t.priority === 'Urgent'));
  check('list responses are paginated', !!list.body?.meta?.pages);

  const search = await api('GET', '/api/tickets?q=parcel');
  check('full-text style search matches',
    search.status === 200 && search.body.data.some((t) => /parcel/i.test(t.subject)));

  const nested = await api('GET', '/api/suppliers/SUP-014');
  check('GET one expands child collections',
    nested.status === 200 && Array.isArray(nested.body.data.certificates));

  const reports = await api('GET', '/api/reports/summary');
  check('reports/summary aggregates', reports.status === 200 && reports.body.data.open_tickets > 0);

  const desks = await api('GET', '/api/reports/desks');
  check('reports/desks reads the view', desks.status === 200 && desks.body.data.length > 0);

  console.log('\n-- write paths --');

  // ---- resource create / update / delete ------------------------------
  const created = await api('POST', '/api/suppliers', {
    id: 'SUP-TEST', name: 'Smoke Test Pharma', country: 'Ireland',
    status: 'Approved', currency: 'EUR',
  });
  check('POST creates a supplier', created.status === 201);
  check('created row is in the database',
    !!one('SELECT 1 FROM suppliers WHERE id = ?', 'SUP-TEST'));

  const dupe = await api('POST', '/api/suppliers', { id: 'SUP-TEST', name: 'Again' });
  check('duplicate primary key returns 409', dupe.status === 409, `got ${dupe.status}`);

  const badEnum = await api('PATCH', '/api/suppliers/SUP-TEST', { status: 'Nonsense' });
  check('CHECK constraint violation returns 400', badEnum.status === 400, `got ${badEnum.status}`);

  const patched = await api('PATCH', '/api/suppliers/SUP-TEST', { status: 'On hold', city: 'Cork' });
  check('PATCH updates only what changed', patched.status === 200 && patched.body.changed === true);
  check('update is visible in the database',
    one('SELECT status FROM suppliers WHERE id = ?', 'SUP-TEST')?.status === 'On hold');

  const noop = await api('PATCH', '/api/suppliers/SUP-TEST', { status: 'On hold' });
  check('a no-op PATCH reports changed:false', noop.body?.changed === false);

  const auditRow = one(
    `SELECT action, before_json, after_json FROM audit_log
     WHERE entity = 'suppliers' AND entity_id = 'SUP-TEST' AND action = 'update'
     ORDER BY id DESC LIMIT 1`
  );
  check('the update wrote an audit row with before/after',
    !!auditRow && JSON.parse(auditRow.after_json).status === 'On hold');

  const removed = await api('DELETE', '/api/suppliers/SUP-TEST');
  check('DELETE removes the row', removed.status === 200);
  check('row is gone from the database',
    !one('SELECT 1 FROM suppliers WHERE id = ?', 'SUP-TEST'));

  const missing = await api('GET', '/api/suppliers/SUP-TEST');
  check('missing record returns 404', missing.status === 404);

  // ---- state round-trip -----------------------------------------------
  console.log('\n-- state round-trip --');

  const noopSave = await api('PUT', '/api/state', S);
  check('saving unchanged state writes nothing',
    noopSave.status === 200 && noopSave.body.changed === false,
    JSON.stringify(noopSave.body?.tables));

  const mutated = JSON.parse(JSON.stringify(S));
  const targetTicket = mutated.tickets[0].id;
  mutated.tickets[0].pri = 'Urgent';
  mutated.tickets[0].thread.push({
    who: 'Smoke Test', side: 'out', chan: 'Email', at: 'now', txt: 'written by the smoke test',
  });
  mutated.tickets.push({
    id: 'TK-SMOKE', from: 'Smoke Tester', who: 'Patient', subj: 'Created by the smoke test',
    prev: '', chan: 'Email', desk: 'Support', unread: true, star: false, att: false,
    time: 'now', pri: 'Normal', folder: 'inbox',
    thread: [{ who: 'Smoke Tester', side: 'in', chan: 'Email', at: 'now', txt: 'hello' }],
  });
  mutated.qa[0].status = 'released';
  mutated.holidays.push({
    id: 'H-SMOKE', d: '25 Dec 2026', n: 'Smoke Day', o: 'All offices',
    t: 'National', a: 'Test',
  });

  const saved = await api('PUT', '/api/state', mutated);
  check('PUT /api/state accepts the change', saved.status === 200 && saved.body.changed === true);
  check('only the touched tables were written',
    saved.body.tables && Object.keys(saved.body.tables).every(
      (t) => ['tickets', 'qa_batches', 'holidays'].includes(t)),
    JSON.stringify(Object.keys(saved.body?.tables || {})));

  check('new ticket row exists', !!one('SELECT 1 FROM tickets WHERE id = ?', 'TK-SMOKE'));
  check('its thread row exists',
    one('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id = ?', 'TK-SMOKE').n === 1);
  check('priority change persisted',
    one('SELECT priority FROM tickets WHERE id = ?', targetTicket)?.priority === 'Urgent');
  check('appended thread message persisted',
    many('SELECT body FROM ticket_messages WHERE ticket_id = ? ORDER BY position', targetTicket)
      .some((m) => m.body === 'written by the smoke test'));
  check('qa status persisted',
    one('SELECT status FROM qa_batches ORDER BY position LIMIT 1')?.status === 'released');
  check('new holiday persisted', !!one('SELECT 1 FROM holidays WHERE id = ?', 'H-SMOKE'));

  // deletes propagate too
  const pruned = JSON.parse(JSON.stringify(mutated));
  pruned.tickets = pruned.tickets.filter((t) => t.id !== 'TK-SMOKE');
  pruned.holidays = pruned.holidays.filter((h) => h.id !== 'H-SMOKE');
  const afterDelete = await api('PUT', '/api/state', pruned);
  check('removing items from state deletes the rows',
    afterDelete.status === 200 &&
    !one('SELECT 1 FROM tickets WHERE id = ?', 'TK-SMOKE') &&
    !one('SELECT 1 FROM holidays WHERE id = ?', 'H-SMOKE'));
  check('cascade removed the orphaned thread',
    one('SELECT COUNT(*) n FROM ticket_messages WHERE ticket_id = ?', 'TK-SMOKE').n === 0);

  // ---- integrity --------------------------------------------------------
  console.log('\n-- integrity --');
  check('no foreign key violations', db.pragma('foreign_key_check').length === 0);
  const ic = db.pragma('integrity_check');
  check('sqlite integrity_check is ok', ic[0]?.integrity_check === 'ok');

  // ---- auth ------------------------------------------------------------
  console.log('\n-- auth --');
  const badLogin = await api('POST', '/api/auth/login', {
    email: 'priya@appleglobalcare.com', password: 'wrong',
  });
  check('wrong password is rejected', badLogin.status === 401);

  const goodLogin = await api('POST', '/api/auth/login', {
    email: 'priya@appleglobalcare.com', password: 'Welcome@123',
  });
  check('correct password issues a token', goodLogin.status === 200 && !!goodLogin.body.token);
  check('login response carries role permissions',
    Array.isArray(goodLogin.body?.user?.permissions) && goodLogin.body.user.permissions.length > 0);
  check('login was audited',
    !!one("SELECT 1 FROM audit_log WHERE action = 'login' ORDER BY id DESC LIMIT 1"));

  const roles = await api('GET', '/api/auth/roles');
  check('roles endpoint lists permissions',
    roles.status === 200 && roles.body.data.length === 6);

  // ---- the sign-in page's account picker --------------------------------
  const accounts = await api('GET', '/api/auth/accounts');
  check('accounts endpoint answers without a token', accounts.status === 200);
  check('accounts are listed in a demo build',
    accounts.body.demo === true && accounts.body.data.length === 6);
  check('every listed account carries a role and an avatar',
    accounts.body.data.every((a) => a.email && a.roleName && a.avatar));
  check('no password hash is ever sent to the browser',
    !JSON.stringify(accounts.body).includes('$2'));

  // The picker fills the form in; /login still does the authenticating. If
  // an account it offers cannot actually sign in, the page is lying.
  let everyAccountCanSignIn = true;
  for (const acct of accounts.body.data) {
    const res = await api('POST', '/api/auth/login', {
      email: acct.email, password: accounts.body.password,
    });
    if (res.status !== 200 || !res.body.token) everyAccountCanSignIn = false;
  }
  check('every offered account can actually sign in', everyAccountCanSignIn);

  // ---- restore ----------------------------------------------------------
  console.log('\n-- restoring the seeded dataset --');
  const reset = await api('POST', '/api/state/reset');
  check('reset re-seeds the database', reset.status === 200);
  check('ticket count is back to 41',
    one('SELECT COUNT(*) n FROM tickets').n === 41,
    String(one('SELECT COUNT(*) n FROM tickets').n));

  // ---- report -----------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed) {
    console.log('Failures:');
    for (const f of failures) console.log('  - ' + f);
    console.log('');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nSmoke test crashed:', err);
  process.exit(1);
});
