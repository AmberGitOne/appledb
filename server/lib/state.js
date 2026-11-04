'use strict';
/**
 * State mapper - the bridge between the relational tables and the object
 * shape the browser app works with.
 *
 *   readState()            build the app state from SQL (SELECTs + joins)
 *   writeState(state, actor)  persist it back, row by row, in one transaction
 *
 * The write path does NOT blindly overwrite. It loads what is currently
 * stored, compares it with what arrived, and issues only the INSERT / UPDATE
 * / DELETE statements that are actually needed - so the audit trail records
 * real changes rather than one giant "everything was saved" event.
 */

const { db } = require('../db');
const audit = require('./audit');

const b = (v) => (v ? 1 : 0);          // -> SQLite integer boolean
const B = (v) => !!v;                  // -> JS boolean
const s = (v) => (v === undefined || v === null ? '' : String(v));
const n = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

const MAIN_CASE_KEY = 'caseManager';   // settings key holding the case manager

// ---------------------------------------------------------------------
// settings helpers
// ---------------------------------------------------------------------

const selSettings = db.prepare('SELECT key, value, value_type FROM settings');
const upsertSetting = db.prepare(`
  INSERT INTO settings (key, value, value_type, updated_at)
  VALUES (?, ?, ?, now_text())
  ON CONFLICT(key) DO UPDATE SET
    value = excluded.value,
    value_type = excluded.value_type,
    updated_at = now_text()
`);

async function readSettings() {
  const out = {};
  for (const row of await selSettings.all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { out[row.key] = row.value; }
  }
  return out;
}

async function writeSetting(key, value, actor) {
  const current = await db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  const next = JSON.stringify(value === undefined ? null : value);
  if (current && current.value === next) return false;
  const type = typeof value === 'number' ? 'number'
    : typeof value === 'boolean' ? 'boolean'
    : value && typeof value === 'object' ? 'json' : 'string';
  await upsertSetting.run(key, next, type);
  await audit.record(actor, current ? 'update' : 'create', 'settings', key,
    current ? { value: current.value } : null, { value: next });
  return true;
}

// ---------------------------------------------------------------------
// Generic collection sync
// ---------------------------------------------------------------------

/**
 * Reconcile a table against an incoming array.
 *
 * @param {object} cfg
 *   table    SQL table name
 *   pk       primary key column
 *   entity   name used in the audit trail
 *   rows     incoming objects
 *   toRow    (obj, index) => { column: value }   (must include the pk)
 *   scope    optional { sql, params, defaults } limiting which rows this
 *            collection owns (e.g. orders split by `completed`)
 *   children optional (pk, obj) => void, called when the row is new or changed
 */
async function syncCollection(cfg, actor, stats) {
  const { table, pk, entity, rows = [], toRow, scope, children } = cfg;

  const whereScope = scope ? ` WHERE ${scope.sql}` : '';
  const existing = new Map(
    (await db.prepare(`SELECT * FROM ${table}${whereScope}`)
      .all(...(scope?.params || [])))
      .map((r) => [String(r[pk]), r])
  );

  const seen = new Set();
  let created = 0, updated = 0, deleted = 0;

  for (const [index, obj] of rows.entries()) {
    const row = { ...(scope?.defaults || {}), ...toRow(obj, index) };
    const id = String(row[pk]);
    if (!id || id === 'undefined' || id === 'null') continue;
    seen.add(id);

    const prev = existing.get(id);

    if (!prev) {
      const cols = Object.keys(row);
      (await db.prepare(
        `INSERT INTO ${table} (${cols.join(',')})
         VALUES (${cols.map(() => '?').join(',')})`
      )).run(...cols.map((c) => row[c]));
      await audit.record(actor, 'create', entity, id, null, row);
      created++;
      if (children) await children(id, obj);
      continue;
    }

    // Only write the columns whose value actually moved.
    const changed = {};
    for (const [col, val] of Object.entries(row)) {
      if (col === pk) continue;
      const before = prev[col];
      const same = before === val ||
        (before === null && (val === '' || val === null)) ||
        (typeof before === 'number' && Number(val) === before) ||
        String(before ?? '') === String(val ?? '');
      if (!same) changed[col] = val;
    }

    if (Object.keys(changed).length) {
      const cols = Object.keys(changed);
      (await db.prepare(
        `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${pk} = ?`
      )).run(...cols.map((c) => changed[c]), id);
      const before = {};
      for (const c of cols) before[c] = prev[c];
      await audit.record(actor, 'update', entity, id, before, changed);
      updated++;
    }

    if (children) await children(id, obj);
  }

  for (const [id, prev] of existing) {
    if (seen.has(id)) continue;
    (await db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`)).run(id);
    await audit.record(actor, 'delete', entity, id, prev, null);
    deleted++;
  }

  if (created || updated || deleted) {
    stats[entity] = { created, updated, deleted };
  }
}

/**
 * Replace a parent's child rows, but only when they actually differ.
 * Avoids churning autoincrement ids on every save.
 */
async function replaceChildren({ table, fk, parentId, incoming, toRow, orderBy = 'position' }) {
  const current = await db
    .prepare(`SELECT * FROM ${table} WHERE ${fk} = ? ORDER BY ${orderBy}`)
    .all(parentId);

  const wanted = incoming.map((obj, i) => toRow(obj, i));

  // Compare only the columns we would write.
  const sig = (rows) =>
    JSON.stringify(rows.map((r) => {
      const keys = Object.keys(wanted[0] || r).filter((k) => k !== 'id').sort();
      return keys.map((k) => String(r[k] ?? ''));
    }));

  if (current.length === wanted.length && sig(current) === sig(wanted)) return false;

  (await db.prepare(`DELETE FROM ${table} WHERE ${fk} = ?`)).run(parentId);
  for (const row of wanted) {
    const cols = Object.keys(row);
    (await db.prepare(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    )).run(...cols.map((c) => row[c]));
  }
  return true;
}

/** Activity feeds (order log, QA log...) are small and ordered - replace wholesale. */
async function syncActivity(stream, refId, rows = [], actor, stats) {
  const current = await db
    .prepare('SELECT title, actor, at_label FROM activity_log WHERE stream = ? ORDER BY position')
    .all(stream);
  const wanted = rows.map((r) => ({ title: s(r.t), actor: s(r.by), at_label: s(r.at) }));

  if (JSON.stringify(current) === JSON.stringify(wanted)) return;

  (await db.prepare('DELETE FROM activity_log WHERE stream = ?')).run(stream);
  const ins = db.prepare(
    'INSERT INTO activity_log (stream, ref_id, title, actor, at_label, position) VALUES (?,?,?,?,?,?)'
  );
  for (const [i, r] of wanted.entries()) {
    await ins.run(stream, s(refId), r.title, r.actor, r.at_label, i);
  }
  await audit.record(actor, 'update', 'activity_log', stream,
    { count: current.length }, { count: wanted.length });
  stats['activity:' + stream] = { created: wanted.length, updated: 0, deleted: current.length };
}

// =====================================================================
// READ
// =====================================================================

async function readState() {
  const cfg = await readSettings();
  const mainCase =
    await db.prepare("SELECT id FROM cases ORDER BY (manager <> '') DESC, id LIMIT 1").get()?.id || null;

  // --- tickets with their threads, attachments and labels -------------
  const ticketRows = await db.prepare('SELECT * FROM tickets ORDER BY position, id').all();
  const msgRows = await db.prepare('SELECT * FROM ticket_messages ORDER BY ticket_id, position').all();
  const attRows = await db.prepare('SELECT * FROM attachments').all();
  const tlRows = await db.prepare('SELECT * FROM ticket_labels').all();

  const attByMsg = new Map();
  for (const a of attRows) {
    if (a.message_id == null) continue;
    const label = a.size_label ? `${a.filename} · ${a.size_label}` : a.filename;
    if (!attByMsg.has(a.message_id)) attByMsg.set(a.message_id, []);
    attByMsg.get(a.message_id).push(label);
  }
  const msgByTicket = new Map();
  for (const m of msgRows) {
    const msg = { who: m.author, side: m.direction, at: m.at_label, txt: m.body };
    if (m.channel) msg.chan = m.channel;
    const att = attByMsg.get(m.id);
    if (att && att.length) msg.att = att;
    if (!msgByTicket.has(m.ticket_id)) msgByTicket.set(m.ticket_id, []);
    msgByTicket.get(m.ticket_id).push(msg);
  }
  const labelsByTicket = new Map();
  for (const tl of tlRows) {
    if (!labelsByTicket.has(tl.ticket_id)) labelsByTicket.set(tl.ticket_id, []);
    labelsByTicket.get(tl.ticket_id).push(tl.label_id);
  }

  const tickets = ticketRows.map((t) => {
    const o = {
      id: t.id, from: t.sender, who: t.sender_kind, subj: t.subject, prev: t.preview,
      chan: t.channel, desk: t.desk, unread: B(t.unread), star: B(t.starred),
      att: B(t.has_attachment), time: t.time_label, pri: t.priority, folder: t.folder,
      thread: msgByTicket.get(t.id) || [],
    };
    if (t.owner) o.owner = t.owner;
    if (t.status) o.status = t.status;
    if (t.previous_desk) o.was = t.previous_desk;
    if (t.escalated_to) o.esc = t.escalated_to;
    if (t.breached) o.breached = true;
    if (t.snoozed_until) o.snoozed = t.snoozed_until;
    const labels = labelsByTicket.get(t.id);
    if (labels && labels.length) o.labels = labels;
    return o;
  });

  // --- RFQ -------------------------------------------------------------
  const rfqRow = await db.prepare('SELECT * FROM rfqs ORDER BY id LIMIT 1').get();
  let rfq = null;
  if (rfqRow) {
    const lines = (await db.prepare('SELECT * FROM rfq_lines WHERE rfq_id = ? ORDER BY position')
      .all(rfqRow.id))
      .map((l) => ({
        country: l.country, partner: l.partner, maker: l.maker, pack: l.pack,
        batch: l.batch, exp: l.expiry, avail: l.available, landed: l.landed_cost,
        lead: l.lead_days, rating: l.rating, flag: l.flag, note: l.note,
        state: l.state, sel: B(l.selected),
      }));
    rfq = {
      id: rfqRow.id, drug: rfqRow.drug, spec: rfqRow.spec, qty: rfqRow.quantity,
      need: rfqRow.needed_by, dest: rfqRow.destination, storage: rfqRow.storage,
      case: rfqRow.case_id || '', sent: rfqRow.sent_at,
      lines,
      log: await readActivity('rfq'),
    };
  }

  // --- quote -----------------------------------------------------------
  const quoteRow = await db.prepare('SELECT * FROM quotes ORDER BY id LIMIT 1').get();
  let quote = null;
  if (quoteRow) {
    const opts = (await db.prepare('SELECT * FROM quote_options WHERE quote_id = ? ORDER BY position')
      .all(quoteRow.id))
      .map((o) => ({
        k: o.opt_key, name: o.name, note: o.note, origin: o.origin,
        lead: o.lead_days, landed: o.landed_cost, fee: o.service_fee,
        show: B(o.visible), def: B(o.is_default),
      }));
    quote = {
      id: quoteRow.id, patient: quoteRow.patient, drug: quoteRow.drug,
      case: quoteRow.case_id || '', status: quoteRow.status,
      opts, log: await readActivity('quote'),
    };
  }

  // --- orders ----------------------------------------------------------
  const orderRow = (o) => {
    const r = {
      id: o.id, drug: o.drug, who: o.patient, country: o.country,
      cold: B(o.cold_chain), note: o.note, due: o.due_label, left: o.left_label,
      risk: B(o.at_risk), pay: o.payment_state, owner: o.owner, stage: o.stage,
      val: o.value_label, case: o.case_id || '',
    };
    if (o.hold_reason) r.hold = o.hold_reason;
    return r;
  };
  const orders = (await db.prepare('SELECT * FROM orders WHERE completed = 0 ORDER BY position, id')
    .all()).map(orderRow);
  const orddone = (await db.prepare('SELECT * FROM orders WHERE completed = 1 ORDER BY position, id')
    .all()).map((o) => ({ id: o.id, drug: o.drug, who: o.patient, at: o.completed_at }));

  // --- warehouse wave --------------------------------------------------
  const wave = (await db.prepare('SELECT * FROM wave_lines ORDER BY position, id').all()).map((w) => {
    const o = {
      id: w.id, who: w.patient, drug: w.drug, batch: w.batch, exp: w.expiry,
      loc: w.location, qty: w.quantity, fefo: w.fefo, st: w.state, cold: B(w.cold_chain),
    };
    if (w.alt_batch) o.alt = { batch: w.alt_batch, exp: w.alt_expiry, loc: w.alt_location };
    return o;
  });

  // --- QA --------------------------------------------------------------
  const qaChecks = await groupChecks('qa_checks', 'batch_id');
  const qa = (await db.prepare('SELECT * FROM qa_batches ORDER BY position, id').all()).map((q) => ({
    id: q.id, prod: q.product, batch: q.batch, sup: q.supplier, exp: q.expiry,
    temp: q.temperature, tempok: B(q.temp_ok), handling: q.handling, forwhom: q.for_whom,
    recv: q.received, signer: q.signer, waiting: q.waiting, status: q.status,
    mine: B(q.assigned_to_me), checks: qaChecks.get(q.id) || [],
    ...(q.quarantine_reason ? { quarWhy: q.quarantine_reason } : {}),
  }));
  const qadev = (await db.prepare('SELECT * FROM qa_deviations ORDER BY id').all()).map((d) => ({
    id: d.id, batch: d.batch, what: d.what, sev: d.severity, state: d.state,
  }));

  // --- prescriptions ---------------------------------------------------
  const rxChecks = await groupChecks('rx_checks', 'rx_id');
  const rx = (await db.prepare('SELECT * FROM prescriptions ORDER BY position, id').all()).map((r) => ({
    id: r.id, pat: r.patient, dob: r.dob, mrn: r.mrn, country: r.country, drug: r.drug,
    dose: r.dose, diag: r.diagnosis, hosp: r.hospital, dept: r.department,
    presc: r.prescriber, reg: r.registration, dated: r.dated, got: r.received,
    tag: r.tag, tagc: r.tag_colour, age: r.age_label, sla: B(r.sla_breached),
    mine: B(r.assigned_to_me), case: r.case_id || '', auth: r.authorised,
    used: r.used, rel: r.released, exp: r.expiry,
    checks: rxChecks.get(r.id) || [], status: r.status,
  }));
  const rxq = (await db.prepare('SELECT * FROM rx_queries ORDER BY position, id').all()).map((q) => ({
    id: q.id, pat: q.patient, q: q.question, sent: q.sent_at, state: q.state, ans: q.answer,
    ...(q.rx_id ? { rx: q.rx_id } : {}),
  }));

  // --- suppliers -------------------------------------------------------
  const certsBySupplier = new Map();
  for (const c of await db.prepare('SELECT * FROM supplier_certificates ORDER BY id').all()) {
    if (!certsBySupplier.has(c.supplier_id)) certsBySupplier.set(c.supplier_id, []);
    certsBySupplier.get(c.supplier_id).push({
      // ids are stored prefixed with the supplier; hand back the short form
      id: c.id.startsWith(c.supplier_id + '-') ? c.id.slice(c.supplier_id.length + 1) : c.id,
      type: c.cert_type, no: c.cert_number, body: c.issuing_body,
      issued: c.issued_on, exp: c.expires_on,
    });
  }
  const suppliers = (await db.prepare('SELECT * FROM suppliers ORDER BY id').all()).map((x) => ({
    id: x.id, name: x.name, code: x.code, cat: x.category, country: x.country, city: x.city,
    reg: x.registration, contact: x.contact, email: x.email, phone: x.phone,
    terms: x.payment_terms, cur: x.currency, lead: x.lead_time, status: x.status,
    rating: x.rating, audit: x.last_audit, naudit: x.next_audit, spend: x.spend,
    note: x.note, certs: certsBySupplier.get(x.id) || [],
  }));

  // --- people ----------------------------------------------------------
  const benByEmp = new Map();
  for (const r of await db.prepare(
    `SELECT eb.employee_id, b.name
     FROM employee_benefits eb JOIN benefits b ON b.id = eb.benefit_id
     ORDER BY eb.employee_id, b.name`
  ).all()) {
    if (!benByEmp.has(r.employee_id)) benByEmp.set(r.employee_id, []);
    benByEmp.get(r.employee_id).push(r.name);
  }
  const employees = (await db.prepare('SELECT * FROM employees ORDER BY position, id').all()).map((e) => ({
    id: e.id, name: e.name, dept: e.department, doa: e.date_of_joining, sal: e.salary,
    leave: e.leave_balance, status: e.status, docs: e.documents,
    ben: benByEmp.get(e.id) || [],
  }));

  const leave = (await db.prepare('SELECT * FROM leave_requests ORDER BY position, id').all()).map((l) => ({
    id: l.id, who: l.who, dept: l.department, type: l.leave_type, from: l.from_date,
    to: l.to_date, days: l.days, reason: l.reason, cover: l.cover, status: l.status,
    mine: B(l.is_mine), clash: B(l.has_clash),
  }));

  const holidays = (await db.prepare('SELECT * FROM holidays ORDER BY position, id').all()).map((h) => ({
    id: h.id, d: h.holiday_date, n: h.name, o: h.offices, t: h.holiday_type, a: h.added_by,
  }));

  const holreq = (await db.prepare('SELECT * FROM holiday_requests ORDER BY id').all()).map((r) => {
    let payload = {};
    try { payload = JSON.parse(r.payload); } catch { /* keep {} */ }
    return { rid: r.id, action: r.action, by: r.requested_by, at: r.requested_at, h: payload };
  });

  // --- the rest --------------------------------------------------------
  const rules = (await db.prepare('SELECT keywords, desk FROM routing_rules ORDER BY position')
    .all()).map((r) => ({ kw: r.keywords, desk: r.desk }));

  const sla = {};
  for (const d of await db.prepare('SELECT name, sla_target FROM desks ORDER BY position').all()) {
    sla[d.name] = d.sla_target;
  }

  const labels = (await db.prepare('SELECT id, name, colour FROM labels ORDER BY position')
    .all()).map((l) => ({ id: l.id, name: l.name, c: l.colour }));

  const notes = (await db.prepare('SELECT * FROM notifications ORDER BY position, id').all()).map((x) => ({
    id: x.id, t: x.title, d: x.detail, go: x.go_route, at: x.at_label, read: B(x.is_read),
  }));

  const caselog = mainCase
    ? (await db.prepare('SELECT * FROM case_timeline WHERE case_id = ? ORDER BY position')
        .all(mainCase))
        .map((l) => ({ c: l.colour, t: l.title, tag: l.tag, at: l.at_label, d: l.detail, k: l.kind }))
    : [];

  const casedocs = mainCase
    ? (await db.prepare('SELECT * FROM case_documents WHERE case_id = ? ORDER BY position')
        .all(mainCase))
        .map((d) => ({ name: d.name, type: d.doc_type, size: d.size_label, by: d.uploaded_by }))
    : [];

  return {
    stage: n(cfg.stage) || 1,
    cur: s(cfg.currentTicket),
    rules, sla,
    marginFloor: n(cfg.marginFloor),
    notes, labels,
    ccdecision: s(cfg.ccDecision),
    cccapa: B(cfg.ccCapa),
    wave,
    whphotos: n(cfg.warehousePhotos),
    caselog, casedocs,
    casemgr: s(cfg.caseManager),
    rfq, quote,
    orders, orddone,
    ordlog: await readActivity('orders'),
    qa, qadev,
    qalog: await readActivity('qa'),
    qareleased: n(cfg.qaReleasedCount),
    rx, rxq,
    rxlog: await readActivity('rx'),
    employees,
    emplog: await readActivity('employees'),
    suppliers, holidays, holreq, leave, tickets,
  };
}

async function readActivity(stream) {
  const rows = await db
    .prepare('SELECT title, actor, at_label FROM activity_log WHERE stream = ? ORDER BY position')
    .all(stream);
  return rows.map((r) => ({ t: r.title, by: r.actor, at: r.at_label }));
}

async function groupChecks(table, fk) {
  const out = new Map();
  for (const c of await db.prepare(`SELECT * FROM ${table} ORDER BY ${fk}, position`).all()) {
    if (!out.has(c[fk])) out.set(c[fk], []);
    out.get(c[fk]).push([c.done ? 1 : 0, c.label, c.detail]);
  }
  return out;
}

// =====================================================================
// WRITE
// =====================================================================

async function writeStateInner(state, actor) {
  const stats = {};
  if (!state || typeof state !== 'object') {
    throw new Error('state must be an object');
  }

  // --- scalars ---------------------------------------------------------
  const scalars = [
    ['stage', state.stage], ['currentTicket', state.cur],
    ['marginFloor', state.marginFloor], ['ccDecision', state.ccdecision],
    ['ccCapa', !!state.cccapa], ['warehousePhotos', state.whphotos],
    ['qaReleasedCount', state.qareleased], ['caseManager', state.casemgr],
  ];
  let settingsChanged = 0;
  for (const [k, v] of scalars) {
    if (v !== undefined && (await writeSetting(k, v, actor))) settingsChanged++;
  }
  if (settingsChanged) stats.settings = { created: 0, updated: settingsChanged, deleted: 0 };

  // --- SLA lives on the desk rows --------------------------------------
  if (state.sla && typeof state.sla === 'object') {
    const upd = db.prepare('UPDATE desks SET sla_target = ? WHERE name = ? AND sla_target <> ?');
    let changed = 0;
    for (const [name, target] of Object.entries(state.sla)) {
      if ((await upd.run(s(target), name, s(target))).changes) {
        await audit.record(actor, 'update', 'desks', name, null, { sla_target: target });
        changed++;
      }
    }
    if (changed) stats.desks = { created: 0, updated: changed, deleted: 0 };
  }

  // --- routing rules (ordered, no natural key: replace) -----------------
  if (Array.isArray(state.rules)) {
    const current = await db.prepare('SELECT keywords, desk FROM routing_rules ORDER BY position').all();
    const wanted = state.rules.map((r) => ({ keywords: s(r.kw), desk: s(r.desk) }));
    if (JSON.stringify(current) !== JSON.stringify(wanted)) {
      (await db.prepare('DELETE FROM routing_rules')).run();
      const ins = db.prepare(
        'INSERT INTO routing_rules (keywords, desk, position, active) VALUES (?,?,?,1)'
      );
      for (const [i, r] of wanted.entries()) await ins.run(r.keywords, r.desk, i);
      await audit.record(actor, 'update', 'routing_rules', '',
        { count: current.length }, { count: wanted.length });
      stats.routing_rules = { created: wanted.length, updated: 0, deleted: current.length };
    }
  }

  // --- labels -----------------------------------------------------------
  if (Array.isArray(state.labels)) {
    await syncCollection({
      table: 'labels', pk: 'id', entity: 'labels', rows: state.labels,
      toRow: (l, i) => ({ id: s(l.id), name: s(l.name), colour: s(l.c) || '#6b7a90', position: i }),
    }, actor, stats);
  }

  // --- notifications ----------------------------------------------------
  if (Array.isArray(state.notes)) {
    await syncCollection({
      table: 'notifications', pk: 'id', entity: 'notifications', rows: state.notes,
      toRow: (x, i) => ({
        id: s(x.id), title: s(x.t), detail: s(x.d), go_route: s(x.go),
        at_label: s(x.at), is_read: b(x.read), position: i,
      }),
    }, actor, stats);
  }

  // --- cases: timeline and documents ------------------------------------
  const mainCase =
    await db.prepare("SELECT id FROM cases ORDER BY (manager <> '') DESC, id LIMIT 1").get()?.id || null;

  if (mainCase && s(state.casemgr)) {
    const upd = db.prepare('UPDATE cases SET manager = ? WHERE id = ? AND manager <> ?');
    await upd.run(s(state.casemgr), mainCase, s(state.casemgr));
  }
  if (mainCase && state.stage !== undefined) {
    const stage = Math.min(Math.max(n(state.stage) || 1, 1), 10);
    (await db.prepare('UPDATE cases SET stage = ? WHERE id = ? AND stage <> ?')).run(stage, mainCase, stage);
  }

  if (mainCase && Array.isArray(state.caselog)) {
    const KINDS = new Set(['ticket', 'quote', 'order', 'payment', 'note', 'doc']);
    const changed = await replaceChildren({
      table: 'case_timeline', fk: 'case_id', parentId: mainCase, incoming: state.caselog,
      toRow: (l, i) => ({
        case_id: mainCase, kind: KINDS.has(l.k) ? l.k : 'note', title: s(l.t),
        detail: s(l.d), tag: s(l.tag), colour: s(l.c) || '#8b98ab',
        at_label: s(l.at), position: i,
      }),
    });
    if (changed) {
      await audit.record(actor, 'update', 'case_timeline', mainCase, null,
        { count: state.caselog.length });
      stats.case_timeline = { created: state.caselog.length, updated: 0, deleted: 0 };
    }
  }

  if (mainCase && Array.isArray(state.casedocs)) {
    const changed = await replaceChildren({
      table: 'case_documents', fk: 'case_id', parentId: mainCase, incoming: state.casedocs,
      toRow: (d, i) => ({
        case_id: mainCase, name: s(d.name || d.n || 'document'),
        doc_type: s(d.type || 'PDF'), size_label: s(d.size),
        uploaded_by: s(d.by), position: i,
      }),
    });
    if (changed) {
      await audit.record(actor, 'update', 'case_documents', mainCase, null,
        { count: state.casedocs.length });
      stats.case_documents = { created: state.casedocs.length, updated: 0, deleted: 0 };
    }
  }

  // --- tickets ----------------------------------------------------------
  if (Array.isArray(state.tickets)) {
    const caseIds = new Set((await db.prepare('SELECT id FROM cases').all()).map((r) => r.id));
    const caseByPatient = new Map(
      (await db.prepare('SELECT id, patient FROM cases').all())
        .map((r) => [String(r.patient).toLowerCase(), r.id])
    );
    const labelIds = new Set((await db.prepare('SELECT id FROM labels').all()).map((r) => r.id));
    const FOLDERS = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam', 'closed']);
    const PRI = new Set(['Low', 'Normal', 'High', 'Urgent']);
    const DIR = new Set(['in', 'out', 'note']);

    await syncCollection({
      table: 'tickets', pk: 'id', entity: 'tickets', rows: state.tickets,
      toRow: (t, i) => ({
        id: s(t.id),
        case_id: (t.case && caseIds.has(t.case))
          ? t.case
          : (caseByPatient.get(String(t.from || '').toLowerCase()) || null),
        sender: s(t.from), sender_kind: s(t.who), subject: s(t.subj), preview: s(t.prev),
        channel: s(t.chan) || 'Email', desk: s(t.desk), owner: s(t.owner),
        priority: PRI.has(t.pri) ? t.pri : 'Normal',
        folder: FOLDERS.has(t.folder) ? t.folder : 'inbox',
        status: s(t.status), previous_desk: s(t.was), escalated_to: s(t.esc),
        time_label: s(t.time), unread: b(t.unread), starred: b(t.star),
        has_attachment: b(t.att), breached: b(t.breached),
        snoozed_until: t.snoozed ? String(t.snoozed) : null,
        position: i,
      }),
      children: async (ticketId, t) => {
        // thread
        const msgsChanged = await replaceChildren({
          table: 'ticket_messages', fk: 'ticket_id', parentId: ticketId,
          incoming: t.thread || [],
          toRow: (m, i) => ({
            ticket_id: ticketId, position: i, author: s(m.who),
            direction: DIR.has(m.side) ? m.side : 'in',
            channel: s(m.chan), at_label: s(m.at), body: s(m.txt),
          }),
        });

        // attachments hang off messages, so re-derive them when the thread moved
        if (msgsChanged) {
          (await db.prepare('DELETE FROM attachments WHERE ticket_id = ?')).run(ticketId);
          const msgIds = await db
            .prepare('SELECT id, position FROM ticket_messages WHERE ticket_id = ? ORDER BY position')
            .all(ticketId);
          const insAtt = db.prepare(
            'INSERT INTO attachments (message_id, ticket_id, filename, file_type, size_label) VALUES (?,?,?,?,?)'
          );
          for (const [i, m] of (t.thread || []).entries()) {
            const mid = msgIds[i]?.id;
            if (!mid) continue;
            for (const a of m.att || []) {
              const [fname, size] = String(a).split('·').map((x) => x.trim());
              const ext = (fname.split('.').pop() || 'file').toUpperCase();
              await insAtt.run(mid, ticketId, fname, ext, size || '');
            }
          }
        }

        // labels
        const currentLabels = (await db
          .prepare('SELECT label_id FROM ticket_labels WHERE ticket_id = ? ORDER BY label_id')
          .all(ticketId)).map((r) => r.label_id);
        const wantedLabels = [...new Set((t.labels || []).filter((l) => labelIds.has(l)))].sort();
        if (JSON.stringify(currentLabels) !== JSON.stringify(wantedLabels)) {
          (await db.prepare('DELETE FROM ticket_labels WHERE ticket_id = ?')).run(ticketId);
          const ins = db.prepare(
            'INSERT INTO ticket_labels (ticket_id, label_id) VALUES (?,?) ON CONFLICT DO NOTHING'
          );
          for (const l of wantedLabels) await ins.run(ticketId, l);
        }
      },
    }, actor, stats);
  }

  // --- RFQ --------------------------------------------------------------
  if (state.rfq && state.rfq.id) {
    const r = state.rfq;
    const caseOk = await db.prepare('SELECT 1 FROM cases WHERE id = ?').get(r.case);
    await syncCollection({
      table: 'rfqs', pk: 'id', entity: 'rfqs', rows: [r],
      toRow: (x) => ({
        id: s(x.id), case_id: caseOk ? x.case : null, drug: s(x.drug), spec: s(x.spec),
        quantity: s(x.qty), needed_by: s(x.need), destination: s(x.dest),
        storage: s(x.storage), sent_at: s(x.sent), status: 'open',
      }),
      children: async (rfqId, x) => {
        await replaceChildren({
          table: 'rfq_lines', fk: 'rfq_id', parentId: rfqId, incoming: x.lines || [],
          toRow: (l, i) => ({
            rfq_id: rfqId, position: i, country: s(l.country), partner: s(l.partner),
            maker: s(l.maker), pack: s(l.pack), batch: s(l.batch), expiry: s(l.exp),
            available: s(l.avail), landed_cost: n(l.landed), lead_days: s(l.lead),
            rating: s(l.rating), flag: s(l.flag), note: s(l.note),
            state: ['in', 'waiting', 'declined'].includes(l.state) ? l.state : 'waiting',
            selected: b(l.sel),
          }),
        });
      },
    }, actor, stats);
    await syncActivity('rfq', r.id, r.log, actor, stats);
  }

  // --- quote ------------------------------------------------------------
  if (state.quote && state.quote.id) {
    const q = state.quote;
    const caseOk = await db.prepare('SELECT 1 FROM cases WHERE id = ?').get(q.case);
    const QS = new Set(['draft', 'sent', 'accepted', 'declined', 'expired']);
    await syncCollection({
      table: 'quotes', pk: 'id', entity: 'quotes', rows: [q],
      toRow: (x) => ({
        id: s(x.id), case_id: caseOk ? x.case : null,
        patient: s(x.patient), drug: s(x.drug),
        status: QS.has(x.status) ? x.status : 'draft',
        accepted_option: (x.opts || []).find((o) => o.def)?.k || null,
      }),
      children: async (quoteId, x) => {
        await replaceChildren({
          table: 'quote_options', fk: 'quote_id', parentId: quoteId, incoming: x.opts || [],
          toRow: (o, i) => ({
            quote_id: quoteId, opt_key: s(o.k), name: s(o.name), note: s(o.note),
            origin: s(o.origin), lead_days: s(o.lead), landed_cost: n(o.landed),
            service_fee: n(o.fee), visible: b(o.show), is_default: b(o.def), position: i,
          }),
        });
      },
    }, actor, stats);
    await syncActivity('quote', q.id, q.log, actor, stats);
  }

  // --- orders (open + completed share one table) ------------------------
  if (Array.isArray(state.orders)) {
    const caseIds = new Set((await db.prepare('SELECT id FROM cases').all()).map((r) => r.id));
    await syncCollection({
      table: 'orders', pk: 'id', entity: 'orders', rows: state.orders,
      scope: { sql: 'completed = 0', params: [], defaults: { completed: 0, completed_at: '' } },
      toRow: (o, i) => ({
        id: s(o.id), case_id: caseIds.has(o.case) ? o.case : null,
        patient: s(o.who), drug: s(o.drug), country: s(o.country), owner: s(o.owner),
        stage: n(o.stage), value_label: s(o.val), payment_state: s(o.pay),
        due_label: s(o.due), left_label: s(o.left), hold_reason: s(o.hold),
        note: s(o.note), cold_chain: b(o.cold), at_risk: b(o.risk), position: i,
      }),
    }, actor, stats);
  }
  if (Array.isArray(state.orddone)) {
    await syncCollection({
      table: 'orders', pk: 'id', entity: 'orders_completed', rows: state.orddone,
      scope: { sql: 'completed = 1', params: [], defaults: { completed: 1 } },
      toRow: (o, i) => ({
        id: s(o.id), patient: s(o.who), drug: s(o.drug),
        completed_at: s(o.at), stage: 10, position: 1000 + i,
      }),
    }, actor, stats);
  }
  if (Array.isArray(state.ordlog)) await syncActivity('orders', '', state.ordlog, actor, stats);

  // --- warehouse wave ----------------------------------------------------
  if (Array.isArray(state.wave)) {
    const orderIds = new Set((await db.prepare('SELECT id FROM orders').all()).map((r) => r.id));
    const WS = new Set(['queued', 'picking', 'picked', 'packed', 'held', 'qa', 'shipped']);
    await syncCollection({
      table: 'wave_lines', pk: 'id', entity: 'wave_lines', rows: state.wave,
      toRow: (w, i) => ({
        id: s(w.id), order_id: orderIds.has(w.id) ? w.id : null, patient: s(w.who),
        drug: s(w.drug), batch: s(w.batch), expiry: s(w.exp), location: s(w.loc),
        quantity: s(w.qty), fefo: w.fefo === 'Breach' ? 'Breach' : 'OK',
        state: WS.has(w.st) ? w.st : 'queued', cold_chain: b(w.cold),
        alt_batch: s(w.alt?.batch), alt_expiry: s(w.alt?.exp), alt_location: s(w.alt?.loc),
        position: i,
        // updated_at is deliberately omitted: stamping it on every save would
        // rewrite all wave rows and fill the audit trail with no-op changes.
      }),
    }, actor, stats);
  }

  // --- QA ----------------------------------------------------------------
  if (Array.isArray(state.qa)) {
    const QS = new Set(['review', 'ready', 'quarantine', 'released', 'rejected']);
    await syncCollection({
      table: 'qa_batches', pk: 'id', entity: 'qa_batches', rows: state.qa,
      toRow: (q, i) => ({
        id: s(q.id), product: s(q.prod), batch: s(q.batch), supplier: s(q.sup),
        expiry: s(q.exp), temperature: s(q.temp), temp_ok: b(q.tempok),
        handling: s(q.handling), for_whom: s(q.forwhom), received: s(q.recv),
        signer: s(q.signer), waiting: s(q.waiting),
        status: QS.has(q.status) ? q.status : 'review',
        assigned_to_me: b(q.mine), quarantine_reason: s(q.quarWhy), position: i,
      }),
      children: async (batchId, q) => {
        await replaceChildren({
          table: 'qa_checks', fk: 'batch_id', parentId: batchId, incoming: q.checks || [],
          toRow: (c, i) => ({
            batch_id: batchId, position: i, done: b(c[0]), label: s(c[1]), detail: s(c[2]),
          }),
        });
      },
    }, actor, stats);
  }
  if (Array.isArray(state.qadev)) {
    const SEV = new Set(['Minor', 'Major', 'Critical']);
    await syncCollection({
      table: 'qa_deviations', pk: 'id', entity: 'qa_deviations', rows: state.qadev,
      toRow: (d) => ({
        id: s(d.id), batch: s(d.batch), what: s(d.what),
        severity: SEV.has(d.sev) ? d.sev : 'Minor', state: s(d.state) || 'open',
      }),
    }, actor, stats);
  }
  if (Array.isArray(state.qalog)) await syncActivity('qa', '', state.qalog, actor, stats);

  // --- prescriptions ------------------------------------------------------
  if (Array.isArray(state.rx)) {
    const caseIds = new Set((await db.prepare('SELECT id FROM cases').all()).map((r) => r.id));
    const RS = new Set(['queue', 'waiting', 'query', 'verified', 'released', 'rejected']);
    await syncCollection({
      table: 'prescriptions', pk: 'id', entity: 'prescriptions', rows: state.rx,
      toRow: (r, i) => ({
        id: s(r.id), case_id: caseIds.has(r.case) ? r.case : null, patient: s(r.pat),
        dob: s(r.dob), mrn: s(r.mrn), country: s(r.country), drug: s(r.drug),
        dose: s(r.dose), diagnosis: s(r.diag), hospital: s(r.hosp), department: s(r.dept),
        prescriber: s(r.presc), registration: s(r.reg), dated: s(r.dated),
        received: s(r.got), tag: s(r.tag), tag_colour: s(r.tagc), age_label: s(r.age),
        authorised: s(r.auth), used: s(r.used), released: s(r.rel), expiry: s(r.exp),
        status: RS.has(r.status) ? r.status : 'queue',
        sla_breached: b(r.sla), assigned_to_me: b(r.mine), position: i,
      }),
      children: async (rxId, r) => {
        await replaceChildren({
          table: 'rx_checks', fk: 'rx_id', parentId: rxId, incoming: r.checks || [],
          toRow: (c, i) => ({
            rx_id: rxId, position: i, done: b(c[0]), label: s(c[1]), detail: s(c[2]),
          }),
        });
      },
    }, actor, stats);
  }
  if (Array.isArray(state.rxq)) {
    const rxIds = new Set((await db.prepare('SELECT id FROM prescriptions').all()).map((r) => r.id));
    await syncCollection({
      table: 'rx_queries', pk: 'id', entity: 'rx_queries', rows: state.rxq,
      toRow: (q, i) => ({
        id: s(q.id), rx_id: rxIds.has(q.rx) ? q.rx : null, patient: s(q.pat),
        question: s(q.q), sent_at: s(q.sent), state: s(q.state) || 'waiting',
        answer: s(q.ans), position: i,
      }),
    }, actor, stats);
  }
  if (Array.isArray(state.rxlog)) await syncActivity('rx', '', state.rxlog, actor, stats);

  // --- suppliers ----------------------------------------------------------
  if (Array.isArray(state.suppliers)) {
    const SS = new Set(['Approved', 'On hold', 'Under review', 'Blocked']);
    await syncCollection({
      table: 'suppliers', pk: 'id', entity: 'suppliers', rows: state.suppliers,
      toRow: (x) => ({
        id: s(x.id), name: s(x.name), code: s(x.code), category: s(x.cat),
        country: s(x.country), city: s(x.city), registration: s(x.reg),
        contact: s(x.contact), email: s(x.email), phone: s(x.phone),
        payment_terms: s(x.terms), currency: s(x.cur) || 'USD', lead_time: s(x.lead),
        status: SS.has(x.status) ? x.status : 'Under review', rating: s(x.rating),
        last_audit: s(x.audit), next_audit: s(x.naudit), spend: s(x.spend), note: s(x.note),
      }),
      children: async (supId, x) => {
        await replaceChildren({
          table: 'supplier_certificates', fk: 'supplier_id', parentId: supId,
          incoming: x.certs || [], orderBy: 'id',
          toRow: (c, i) => ({
            id: `${supId}-${s(c.id) || 'C' + (i + 1)}`, supplier_id: supId,
            cert_type: s(c.type), cert_number: s(c.no), issuing_body: s(c.body),
            issued_on: s(c.issued), expires_on: s(c.exp),
          }),
        });
      },
    }, actor, stats);
  }

  // --- people --------------------------------------------------------------
  if (Array.isArray(state.employees)) {
    const benefitByName = new Map(
      (await db.prepare('SELECT id, name FROM benefits').all()).map((r) => [r.name, r.id])
    );
    const insBenefit = db.prepare('INSERT INTO benefits (id, name) VALUES (?,?) ON CONFLICT DO NOTHING');

    await syncCollection({
      table: 'employees', pk: 'id', entity: 'employees', rows: state.employees,
      toRow: (e, i) => ({
        id: s(e.id), name: s(e.name), department: s(e.dept), date_of_joining: s(e.doa),
        salary: s(e.sal), leave_balance: s(e.leave), status: s(e.status) || 'Active',
        documents: s(e.docs), position: i,
      }),
      children: async (empId, e) => {
        const wanted = [];
        for (const name of e.ben || []) {
          if (!benefitByName.has(name)) {
            const id = 'ben-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            await insBenefit.run(id, name);
            benefitByName.set(name, id);
          }
          wanted.push(benefitByName.get(name));
        }
        wanted.sort();
        const current = (await db
          .prepare('SELECT benefit_id FROM employee_benefits WHERE employee_id = ? ORDER BY benefit_id')
          .all(empId)).map((r) => r.benefit_id);
        if (JSON.stringify(current) !== JSON.stringify([...new Set(wanted)])) {
          (await db.prepare('DELETE FROM employee_benefits WHERE employee_id = ?')).run(empId);
          const ins = db.prepare(
            'INSERT INTO employee_benefits (employee_id, benefit_id) VALUES (?,?) ON CONFLICT DO NOTHING'
          );
          for (const bid of new Set(wanted)) await ins.run(empId, bid);
        }
      },
    }, actor, stats);
  }
  if (Array.isArray(state.emplog)) await syncActivity('employees', '', state.emplog, actor, stats);

  if (Array.isArray(state.leave)) {
    const empIds = new Set((await db.prepare('SELECT id FROM employees').all()).map((r) => r.id));
    const empByName = new Map(
      (await db.prepare('SELECT id, name FROM employees').all()).map((r) => [r.name, r.id])
    );
    const LS = new Set(['waiting', 'approved', 'rejected', 'cancelled', 'recorded', 'lop']);
    await syncCollection({
      table: 'leave_requests', pk: 'id', entity: 'leave_requests', rows: state.leave,
      toRow: (l, i) => ({
        id: s(l.id), employee_id: empByName.get(l.who) || null, who: s(l.who),
        department: s(l.dept), leave_type: s(l.type), from_date: s(l.from),
        to_date: s(l.to), days: s(l.days), reason: s(l.reason), cover: s(l.cover),
        status: LS.has(l.status) ? l.status : 'waiting',
        is_mine: b(l.mine), has_clash: b(l.clash), position: i,
      }),
    }, actor, stats);
    void empIds;
  }

  if (Array.isArray(state.holidays)) {
    await syncCollection({
      table: 'holidays', pk: 'id', entity: 'holidays', rows: state.holidays,
      toRow: (h, i) => ({
        id: s(h.id), holiday_date: s(h.d), name: s(h.n), offices: s(h.o),
        holiday_type: s(h.t) || 'Company-wide', added_by: s(h.a), position: i,
      }),
    }, actor, stats);
  }

  if (Array.isArray(state.holreq)) {
    await syncCollection({
      table: 'holiday_requests', pk: 'id', entity: 'holiday_requests', rows: state.holreq,
      toRow: (r) => ({
        id: s(r.rid), action: ['add', 'edit', 'remove'].includes(r.action) ? r.action : 'add',
        requested_by: s(r.by), requested_at: s(r.at),
        payload: JSON.stringify(r.h || {}), state: 'waiting',
      }),
    }, actor, stats);
  }

  return stats;
}

/** Persist the whole state atomically. Returns a per-table change summary. */
const writeState = db.transaction((state, actor) => writeStateInner(state, actor));

module.exports = { readState, writeState, readSettings, writeSetting };
