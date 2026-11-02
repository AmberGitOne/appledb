'use strict';
/**
 * Seeder - loads data/seed.json (extracted from the original prototype)
 * into the normalised tables with real parameterised SQL.
 *
 *   node server/db/seed.js
 *
 * Idempotent: it clears the data tables first, so running it again gives a
 * clean demo dataset. This is what the app's "Reset demo data" button calls.
 */

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { db } = require('./index');

const ROOT = path.join(__dirname, '..', '..');
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'seed.json'), 'utf8'));

const DESK_NAMES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'desks.json'), 'utf8'));

const DESK_COLOURS = {
  Sales: '#2E8FE8', Marketing: '#8B5CF6', 'Digital marketing': '#3B1E9E',
  Design: '#F4705E', Support: '#0E7C8C', Processing: '#5B34C9',
  Shipping: '#14908C', Warehouse: '#0B6E6B', Sourcing: '#37B44A',
  Pharmacy: '#29CFD6', Quality: '#1E7D34', 'Quality & regulatory': '#1E7D34',
  Accounts: '#1565C0', Legal: '#3E5C9A', 'HR & admin': '#1B3C8F',
  'IT & systems': '#E8412B', Pharmacovigilance: '#1E7D34',
};

const BENEFIT_NAMES = [
  'PF', 'Insurance', 'Med-claim', 'Term plan', 'Gratuity',
  'Personal accident', 'ESI', 'Transport allowance',
];

const bool = (v) => (v ? 1 : 0);
const str = (v) => (v === undefined || v === null ? '' : String(v));
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);

// Tables cleared on reseed, children before parents.
const DATA_TABLES = [
  'audit_log', 'activity_log',
  'holiday_requests', 'holidays', 'leave_requests',
  'employee_benefits', 'benefits', 'employees',
  'rx_queries', 'rx_checks', 'prescriptions',
  'qa_deviations', 'qa_checks', 'qa_batches',
  'wave_lines', 'orders',
  'quote_options', 'quotes',
  'rfq_lines', 'rfqs',
  'attachments', 'ticket_messages', 'ticket_labels', 'tickets',
  'case_documents', 'case_timeline', 'cases',
  'supplier_certificates', 'suppliers',
  'notifications', 'labels', 'routing_rules', 'settings', 'desks',
  'role_permissions', 'permissions', 'users', 'roles',
];

// ---------------------------------------------------------------------
// Access control
// ---------------------------------------------------------------------

const ROLES = [
  ['role-admin',  'Admin',       'Full access to every module and to settings'],
  ['role-manager','Manager',     'Reads every desk, approves quotes, leave and releases'],
  ['role-agent',  'Agent',       'Works tickets, cases, quotes and orders on their own desk'],
  ['role-pharm',  'Pharmacist',  'Verifies prescriptions and signs clinical checks'],
  ['role-qa',     'QA officer',  'Releases batches, raises and closes deviations'],
  ['role-view',   'Viewer',      'Read-only access to dashboards and records'],
];

const RESOURCES = [
  'tickets', 'cases', 'rfqs', 'quotes', 'orders', 'wave',
  'qa', 'prescriptions', 'suppliers', 'employees', 'leave',
  'holidays', 'settings', 'users', 'audit',
];
const ACTIONS = ['read', 'create', 'update', 'delete'];

function roleGrants(roleId) {
  const all = [];
  for (const r of RESOURCES) for (const a of ACTIONS) all.push(`${r}:${a}`);

  switch (roleId) {
    case 'role-admin':
      return all;
    case 'role-manager':
      return all.filter((p) => !p.startsWith('users:') && !p.endsWith(':delete'));
    case 'role-agent':
      return all.filter((p) =>
        /^(tickets|cases|rfqs|quotes|orders|wave):(read|create|update)$/.test(p) ||
        /^(suppliers|prescriptions|qa|employees|leave|holidays|settings):read$/.test(p));
    case 'role-pharm':
      return all.filter((p) =>
        /^prescriptions:(read|create|update)$/.test(p) ||
        /^(tickets|cases|orders|qa):read$/.test(p));
    case 'role-qa':
      return all.filter((p) =>
        /^(qa|wave):(read|create|update)$/.test(p) ||
        /^(suppliers|orders|tickets|cases):read$/.test(p));
    default:
      return all.filter((p) => p.endsWith(':read'));
  }
}

const USERS = [
  ['usr-priya', 'priya@appleglobalcare.com', 'Priya N.',  'role-agent',   'Support',  'Senior agent',        'Grade 4'],
  ['usr-raj',   'raj@appleglobalcare.com',   'Raj K.',    'role-admin',   '',         'Administrator',       'Board'],
  ['usr-arun',  'arun@appleglobalcare.com',  'Arun K.',   'role-qa',      'Quality',  'QA officer',          'Grade 5'],
  ['usr-sara',  'sara@appleglobalcare.com',  'Dr. Sara M.','role-pharm',  'Pharmacy', 'Responsible pharmacist','Grade 6'],
  ['usr-yusuf', 'yusuf@appleglobalcare.com', 'Yusuf A.',  'role-agent',   'Sourcing', 'Sourcing agent',      'Grade 4'],
  ['usr-maria', 'maria@appleglobalcare.com', 'Maria L.',  'role-manager', 'Sales',    'Desk manager',        'Grade 6'],
];

// One source of truth, shared with the sign-in page's account picker.
const { DEMO_PASSWORD: DEFAULT_PASSWORD } = require('../lib/demo');

// ---------------------------------------------------------------------

function seed() {
  console.log('Seeding...');

  db.pragma('foreign_keys = OFF');
  for (const t of DATA_TABLES) {
    try { db.prepare(`DELETE FROM ${t}`).run(); } catch (_) { /* table may not exist */ }
  }
  db.prepare("DELETE FROM sqlite_sequence WHERE name NOT IN ('schema_migrations')").run();
  db.pragma('foreign_keys = ON');

  const counts = {};
  const bump = (k, n = 1) => { counts[k] = (counts[k] || 0) + n; };

  // ---- roles, permissions, users --------------------------------------
  const insRole = db.prepare('INSERT INTO roles (id,name,description) VALUES (?,?,?)');
  for (const r of ROLES) { insRole.run(...r); bump('roles'); }

  const insPerm = db.prepare(
    'INSERT INTO permissions (id,resource,action,description) VALUES (?,?,?,?)'
  );
  for (const res of RESOURCES) {
    for (const act of ACTIONS) {
      insPerm.run(`${res}:${act}`, res, act, `${act} ${res}`);
      bump('permissions');
    }
  }

  const insRP = db.prepare(
    'INSERT OR IGNORE INTO role_permissions (role_id,permission_id) VALUES (?,?)'
  );
  for (const [roleId] of ROLES) {
    for (const perm of roleGrants(roleId)) { insRP.run(roleId, perm); bump('role_permissions'); }
  }

  const hash = bcrypt.hashSync(DEFAULT_PASSWORD, 10);
  const insUser = db.prepare(
    `INSERT INTO users (id,email,name,password_hash,role_id,desk,job_title,grade,avatar)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const [id, email, name, role, desk, title, grade] of USERS) {
    const initials = name.replace(/[^A-Za-z ]/g, '').split(/\s+/)
      .map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    insUser.run(id, email, name, hash, role, desk, title, grade, initials);
    bump('users');
  }

  // ---- desks ----------------------------------------------------------
  const deskNames = [...new Set([...DESK_NAMES, ...Object.keys(SEED.sla || {})])];
  const insDesk = db.prepare(
    'INSERT INTO desks (id,name,colour,sla_target,position) VALUES (?,?,?,?,?)'
  );
  deskNames.forEach((name, i) => {
    const id = 'desk-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    insDesk.run(id, name, DESK_COLOURS[name] || '#6b7a90', (SEED.sla || {})[name] || '8 h', i);
    bump('desks');
  });

  // ---- settings -------------------------------------------------------
  const insSetting = db.prepare(
    'INSERT INTO settings (key,value,value_type) VALUES (?,?,?)'
  );
  const setting = (key, value) => {
    const type = typeof value === 'number' ? 'number'
      : typeof value === 'boolean' ? 'boolean'
      : typeof value === 'object' ? 'json' : 'string';
    insSetting.run(key, JSON.stringify(value), type);
    bump('settings');
  };
  setting('stage', SEED.stage);
  setting('currentTicket', SEED.cur);
  setting('marginFloor', SEED.marginFloor);
  setting('ccDecision', SEED.ccdecision);
  setting('ccCapa', !!SEED.cccapa);
  setting('warehousePhotos', SEED.whphotos);
  setting('qaReleasedCount', SEED.qareleased);
  setting('caseManager', SEED.casemgr);
  setting('companyName', 'Apple Globalcare India Pvt Ltd');
  setting('companyAddress', '4th floor, Prestige Tech Park, Bengaluru 560103');
  setting('companyCIN', 'U51397KA2019PTC122104');

  // ---- routing rules --------------------------------------------------
  const insRule = db.prepare(
    'INSERT INTO routing_rules (keywords,desk,position,active) VALUES (?,?,?,1)'
  );
  (SEED.rules || []).forEach((r, i) => { insRule.run(r.kw, r.desk, i); bump('routing_rules'); });

  // ---- labels ---------------------------------------------------------
  const insLabel = db.prepare('INSERT INTO labels (id,name,colour,position) VALUES (?,?,?,?)');
  (SEED.labels || []).forEach((l, i) => { insLabel.run(l.id, l.name, l.c, i); bump('labels'); });

  // ---- notifications --------------------------------------------------
  const insNote = db.prepare(
    `INSERT INTO notifications (id,title,detail,go_route,at_label,is_read,position)
     VALUES (?,?,?,?,?,?,?)`
  );
  (SEED.notes || []).forEach((n, i) => {
    insNote.run(n.id, n.t, str(n.d), str(n.go), str(n.at), bool(n.read), i);
    bump('notifications');
  });

  // ---- suppliers and certificates -------------------------------------
  const insSup = db.prepare(
    `INSERT INTO suppliers
       (id,name,code,category,country,city,registration,contact,email,phone,
        payment_terms,currency,lead_time,status,rating,last_audit,next_audit,spend,note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insCert = db.prepare(
    `INSERT INTO supplier_certificates
       (id,supplier_id,cert_type,cert_number,issuing_body,issued_on,expires_on)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const s of SEED.suppliers || []) {
    insSup.run(
      s.id, s.name, str(s.code), str(s.cat), str(s.country), str(s.city), str(s.reg),
      str(s.contact), str(s.email), str(s.phone), str(s.terms), str(s.cur) || 'USD',
      str(s.lead), str(s.status) || 'Under review', str(s.rating),
      str(s.audit), str(s.naudit), str(s.spend), str(s.note)
    );
    bump('suppliers');
    for (const c of s.certs || []) {
      insCert.run(`${s.id}-${c.id}`, s.id, c.type, str(c.no), str(c.body), str(c.issued), str(c.exp));
      bump('supplier_certificates');
    }
  }

  // Map a partner/supplier display name back to a supplier id.
  //
  // Names arrive in three shapes: the master name ("Rheinpharm GmbH"), the
  // name without its legal suffix ("Nordic Rare Therapeutics"), and the name
  // plus a licence ("Rheinpharm GmbH - WDA DE-4412"). Normalise away accents,
  // punctuation and the legal suffix, then require one side to be a prefix of
  // the other. That links the three shapes above without falsely joining
  // "Meridian Specialty Rx" to the unrelated "Meridian Clinical Supplies Ltd".
  const LEGAL_SUFFIX = /\b(ltd|limited|llc|l\.l\.c|gmbh|ag|aps|a\/s|kk|k\.k|sac|s\.a\.c|plc|inc|incorporated|bv|b\.v|nv|sa|s\.a|srl|pty|as|oy|ab)\b/g;
  const norm = (s) =>
    String(s || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip accents
      .toLowerCase()
      .split(/[·|,]/)[0]                                  // drop the licence tail
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(LEGAL_SUFFIX, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const supplierIndex = (SEED.suppliers || []).map((s) => [norm(s.name), s.id]);
  const matchSupplier = (text) => {
    const t = norm(text);
    if (t.length < 6) return null;
    for (const [name, id] of supplierIndex) {
      if (name.length < 6) continue;
      if (t === name || t.startsWith(name + ' ') || name.startsWith(t + ' ')) return id;
    }
    return null;
  };

  // ---- cases ----------------------------------------------------------
  // Every case id referenced anywhere becomes a real row, so the foreign
  // keys from tickets / orders / prescriptions actually resolve.
  const casePatients = new Map();
  for (const o of SEED.orders || []) if (o.case) casePatients.set(o.case, o.who);
  for (const r of SEED.rx || []) if (r.case) casePatients.set(r.case, r.pat);
  if (SEED.rfq && SEED.rfq.case) casePatients.set(SEED.rfq.case, SEED.quote?.patient || '');
  if (SEED.quote && SEED.quote.case) casePatients.set(SEED.quote.case, SEED.quote.patient || '');

  const MAIN_CASE = (SEED.quote && SEED.quote.case) || 'CA-2026-0418';
  const insCase = db.prepare(
    'INSERT INTO cases (id,patient,manager,stage,status) VALUES (?,?,?,?,?)'
  );
  for (const [id, patient] of casePatients) {
    const isMain = id === MAIN_CASE;
    const stage = isMain ? Math.min(Math.max(num(SEED.stage) || 1, 1), 10) : 1;
    insCase.run(id, patient || 'Unknown', isMain ? str(SEED.casemgr) : '', stage, 'open');
    bump('cases');
  }

  const insTimeline = db.prepare(
    `INSERT INTO case_timeline (case_id,kind,title,detail,tag,colour,at_label,position)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  const TIMELINE_KINDS = new Set(['ticket', 'quote', 'order', 'payment', 'note', 'doc']);
  (SEED.caselog || []).forEach((l, i) => {
    insTimeline.run(
      MAIN_CASE,
      TIMELINE_KINDS.has(l.k) ? l.k : 'note',
      l.t, str(l.d), str(l.tag), str(l.c) || '#8b98ab', str(l.at), i
    );
    bump('case_timeline');
  });

  const insCaseDoc = db.prepare(
    `INSERT INTO case_documents (case_id,name,doc_type,size_label,uploaded_by,position)
     VALUES (?,?,?,?,?,?)`
  );
  (SEED.casedocs || []).forEach((d, i) => {
    insCaseDoc.run(MAIN_CASE, d.name || d.n || 'document', str(d.type || 'PDF'),
      str(d.size), str(d.by), i);
    bump('case_documents');
  });

  // ---- tickets, threads, attachments ----------------------------------
  // Tickets carry no case id in the prototype; link them by patient name so
  // the case view can actually join its conversations.
  const caseByPatient = new Map();
  for (const [id, patient] of casePatients) {
    if (patient) caseByPatient.set(patient.toLowerCase(), id);
  }

  const insTicket = db.prepare(
    `INSERT INTO tickets
       (id,case_id,sender,sender_kind,subject,preview,channel,desk,owner,priority,
        folder,status,previous_desk,escalated_to,time_label,unread,starred,
        has_attachment,breached,snoozed_until,position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insMsg = db.prepare(
    `INSERT INTO ticket_messages (ticket_id,position,author,direction,channel,at_label,body)
     VALUES (?,?,?,?,?,?,?)`
  );
  const insAtt = db.prepare(
    `INSERT INTO attachments (message_id,ticket_id,filename,file_type,size_label)
     VALUES (?,?,?,?,?)`
  );
  const insTL = db.prepare(
    'INSERT OR IGNORE INTO ticket_labels (ticket_id,label_id) VALUES (?,?)'
  );
  const labelIds = new Set((SEED.labels || []).map((l) => l.id));
  const VALID_FOLDERS = new Set(['inbox', 'sent', 'drafts', 'trash', 'spam', 'closed']);
  const VALID_PRI = new Set(['Low', 'Normal', 'High', 'Urgent']);
  const DIRECTIONS = new Set(['in', 'out', 'note']);

  // The prototype's seed array contains five duplicate ticket ids (it was
  // stored as a plain array in localStorage, so the collision was invisible).
  // A primary key will not tolerate that: keep every ticket, but allocate a
  // fresh id to each repeat and report the remap.
  const seenTicketIds = new Set();
  const remapped = [];
  let nextFree = 58200;
  const uniqueTicketId = (id) => {
    if (!seenTicketIds.has(id)) { seenTicketIds.add(id); return id; }
    let candidate;
    do { candidate = 'TK-' + nextFree++; } while (seenTicketIds.has(candidate));
    seenTicketIds.add(candidate);
    remapped.push([id, candidate]);
    return candidate;
  };

  (SEED.tickets || []).forEach((t, ti) => {
    t.id = uniqueTicketId(t.id);
    insTicket.run(
      t.id,
      caseByPatient.get(String(t.from || '').toLowerCase()) || null,
      str(t.from), str(t.who), str(t.subj), str(t.prev), str(t.chan) || 'Email',
      str(t.desk), str(t.owner),
      VALID_PRI.has(t.pri) ? t.pri : 'Normal',
      VALID_FOLDERS.has(t.folder) ? t.folder : 'inbox',
      str(t.status), str(t.was), str(t.esc), str(t.time),
      bool(t.unread), bool(t.star), bool(t.att), bool(t.breached),
      t.snoozed ? String(t.snoozed) : null,
      ti
    );
    bump('tickets');

    for (const lid of t.labels || []) {
      if (labelIds.has(lid)) { insTL.run(t.id, lid); bump('ticket_labels'); }
    }

    (t.thread || []).forEach((m, mi) => {
      const r = insMsg.run(
        t.id, mi, str(m.who),
        DIRECTIONS.has(m.side) ? m.side : 'in',
        str(m.chan), str(m.at), str(m.txt)
      );
      bump('ticket_messages');
      for (const a of m.att || []) {
        // "Rx-cycles-4-5.pdf · 240 KB"
        const [fname, size] = String(a).split('·').map((x) => x.trim());
        const ext = (fname.split('.').pop() || 'file').toUpperCase();
        insAtt.run(r.lastInsertRowid, t.id, fname, ext, size || '');
        bump('attachments');
      }
    });
  });

  if (remapped.length) {
    console.log(`  note: ${remapped.length} duplicate ticket ids in the source data were reissued:`);
    for (const [from, to] of remapped) console.log(`    ${from} -> ${to}`);
  }

  // ---- RFQ ------------------------------------------------------------
  const insActivity = db.prepare(
    'INSERT INTO activity_log (stream,ref_id,title,actor,at_label,position) VALUES (?,?,?,?,?,?)'
  );
  const activity = (stream, refId, rows) => {
    (rows || []).forEach((l, i) => {
      insActivity.run(stream, str(refId), l.t, str(l.by), str(l.at), i);
      bump('activity_log');
    });
  };

  if (SEED.rfq) {
    const r = SEED.rfq;
    db.prepare(
      `INSERT INTO rfqs (id,case_id,drug,spec,quantity,needed_by,destination,storage,sent_at,status)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      r.id, casePatients.has(r.case) ? r.case : null, r.drug, str(r.spec), str(r.qty),
      str(r.need), str(r.dest), str(r.storage), str(r.sent), 'open'
    );
    bump('rfqs');

    const insLine = db.prepare(
      `INSERT INTO rfq_lines
         (rfq_id,position,country,partner,supplier_id,maker,pack,batch,expiry,available,
          landed_cost,lead_days,rating,flag,note,state,selected)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    (r.lines || []).forEach((l, i) => {
      insLine.run(
        r.id, i, l.country, str(l.partner), matchSupplier(l.partner), str(l.maker),
        str(l.pack), str(l.batch), str(l.exp), str(l.avail), num(l.landed),
        str(l.lead), str(l.rating), str(l.flag), str(l.note),
        ['in', 'waiting', 'declined'].includes(l.state) ? l.state : 'waiting',
        bool(l.sel)
      );
      bump('rfq_lines');
    });
    activity('rfq', r.id, r.log);
  }

  // ---- quote ----------------------------------------------------------
  if (SEED.quote) {
    const q = SEED.quote;
    const VALID_QSTATUS = new Set(['draft', 'sent', 'accepted', 'declined', 'expired']);
    db.prepare(
      `INSERT INTO quotes (id,case_id,rfq_id,patient,drug,status,accepted_option)
       VALUES (?,?,?,?,?,?,?)`
    ).run(
      q.id, casePatients.has(q.case) ? q.case : null,
      SEED.rfq ? SEED.rfq.id : null,
      str(q.patient), str(q.drug),
      VALID_QSTATUS.has(q.status) ? q.status : 'draft',
      (q.opts || []).find((o) => o.def)?.k || null
    );
    bump('quotes');

    const insOpt = db.prepare(
      `INSERT INTO quote_options
         (quote_id,opt_key,name,note,origin,lead_days,landed_cost,service_fee,visible,is_default,position)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    (q.opts || []).forEach((o, i) => {
      insOpt.run(q.id, o.k, str(o.name), str(o.note), str(o.origin), str(o.lead),
        num(o.landed), num(o.fee), bool(o.show), bool(o.def), i);
      bump('quote_options');
    });
    activity('quote', q.id, q.log);
  }

  // ---- orders ---------------------------------------------------------
  const insOrder = db.prepare(
    `INSERT INTO orders
       (id,case_id,quote_id,patient,drug,country,owner,stage,value_label,payment_state,
        due_label,left_label,hold_reason,note,cold_chain,at_risk,completed,completed_at,position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  (SEED.orders || []).forEach((o, i) => {
    insOrder.run(
      o.id, casePatients.has(o.case) ? o.case : null,
      SEED.quote && o.case === SEED.quote.case ? SEED.quote.id : null,
      str(o.who), str(o.drug), str(o.country), str(o.owner), num(o.stage),
      str(o.val), str(o.pay), str(o.due), str(o.left), str(o.hold), str(o.note),
      bool(o.cold), bool(o.risk), 0, '', i
    );
    bump('orders');
  });
  (SEED.orddone || []).forEach((o, i) => {
    insOrder.run(
      o.id, null, null, str(o.who), str(o.drug), '', '', 10,
      '', '', '', '', '', '', 0, 0, 1, str(o.at), 1000 + i
    );
    bump('orders');
  });
  activity('orders', '', SEED.ordlog);

  // ---- warehouse wave -------------------------------------------------
  const orderIds = new Set(db.prepare('SELECT id FROM orders').all().map((r) => r.id));
  const insWave = db.prepare(
    `INSERT INTO wave_lines
       (id,order_id,patient,drug,batch,expiry,location,quantity,fefo,state,
        cold_chain,alt_batch,alt_expiry,alt_location,position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const VALID_WAVE = new Set(['queued', 'picking', 'picked', 'packed', 'held', 'qa', 'shipped']);
  (SEED.wave || []).forEach((w, i) => {
    insWave.run(
      w.id, orderIds.has(w.id) ? w.id : null, str(w.who), str(w.drug), str(w.batch),
      str(w.exp), str(w.loc), str(w.qty),
      w.fefo === 'Breach' ? 'Breach' : 'OK',
      VALID_WAVE.has(w.st) ? w.st : 'queued',
      bool(w.cold),
      str(w.alt?.batch), str(w.alt?.exp), str(w.alt?.loc), i
    );
    bump('wave_lines');
  });

  // ---- QA -------------------------------------------------------------
  const insQA = db.prepare(
    `INSERT INTO qa_batches
       (id,product,batch,supplier,supplier_id,expiry,temperature,temp_ok,handling,
        for_whom,received,signer,waiting,status,assigned_to_me,quarantine_reason,position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insQACheck = db.prepare(
    'INSERT INTO qa_checks (batch_id,position,done,label,detail) VALUES (?,?,?,?,?)'
  );
  const VALID_QA = new Set(['review', 'ready', 'quarantine', 'released', 'rejected']);
  (SEED.qa || []).forEach((q, i) => {
    insQA.run(
      q.id, q.prod, str(q.batch), str(q.sup), matchSupplier(q.sup), str(q.exp),
      str(q.temp), bool(q.tempok), str(q.handling), str(q.forwhom), str(q.recv),
      str(q.signer), str(q.waiting),
      VALID_QA.has(q.status) ? q.status : 'review',
      bool(q.mine), str(q.quarWhy), i
    );
    bump('qa_batches');
    (q.checks || []).forEach((c, ci) => {
      insQACheck.run(q.id, ci, bool(c[0]), str(c[1]), str(c[2]));
      bump('qa_checks');
    });
  });

  const insDev = db.prepare(
    'INSERT INTO qa_deviations (id,batch,batch_id,what,severity,state) VALUES (?,?,?,?,?,?)'
  );
  const qaByBatch = new Map((SEED.qa || []).map((q) => [q.batch, q.id]));
  const VALID_SEV = new Set(['Minor', 'Major', 'Critical']);
  for (const d of SEED.qadev || []) {
    insDev.run(d.id, str(d.batch), qaByBatch.get(d.batch) || null, str(d.what),
      VALID_SEV.has(d.sev) ? d.sev : 'Minor', str(d.state) || 'open');
    bump('qa_deviations');
  }
  activity('qa', '', SEED.qalog);

  // ---- prescriptions --------------------------------------------------
  const insRx = db.prepare(
    `INSERT INTO prescriptions
       (id,case_id,patient,dob,mrn,country,drug,dose,diagnosis,hospital,department,
        prescriber,registration,dated,received,tag,tag_colour,age_label,authorised,
        used,released,expiry,status,sla_breached,assigned_to_me,position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insRxCheck = db.prepare(
    'INSERT INTO rx_checks (rx_id,position,done,label,detail) VALUES (?,?,?,?,?)'
  );
  const VALID_RX = new Set(['queue', 'waiting', 'query', 'verified', 'released', 'rejected']);
  (SEED.rx || []).forEach((r, i) => {
    insRx.run(
      r.id, casePatients.has(r.case) ? r.case : null, r.pat, str(r.dob), str(r.mrn),
      str(r.country), str(r.drug), str(r.dose), str(r.diag), str(r.hosp), str(r.dept),
      str(r.presc), str(r.reg), str(r.dated), str(r.got), str(r.tag), str(r.tagc),
      str(r.age), str(r.auth), str(r.used), str(r.rel), str(r.exp),
      VALID_RX.has(r.status) ? r.status : 'queue',
      bool(r.sla), bool(r.mine), i
    );
    bump('prescriptions');
    (r.checks || []).forEach((c, ci) => {
      insRxCheck.run(r.id, ci, bool(c[0]), str(c[1]), str(c[2]));
      bump('rx_checks');
    });
  });

  const rxIds = new Set((SEED.rx || []).map((r) => r.id));
  const insRxQ = db.prepare(
    'INSERT INTO rx_queries (id,rx_id,patient,question,sent_at,state,answer,position) VALUES (?,?,?,?,?,?,?,?)'
  );
  (SEED.rxq || []).forEach((q, i) => {
    insRxQ.run(q.id, rxIds.has(q.rx) ? q.rx : null, str(q.pat), str(q.q), str(q.sent),
      str(q.state) || 'waiting', str(q.ans), i);
    bump('rx_queries');
  });
  activity('rx', '', SEED.rxlog);

  // ---- employees, benefits, leave, holidays ---------------------------
  const insBenefit = db.prepare('INSERT INTO benefits (id,name) VALUES (?,?)');
  const allBenefits = [...new Set([
    ...BENEFIT_NAMES,
    ...(SEED.employees || []).flatMap((e) => e.ben || []),
  ])];
  const benefitId = new Map();
  allBenefits.forEach((name, i) => {
    const id = 'ben-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    benefitId.set(name, id);
    insBenefit.run(id, name);
    bump('benefits');
  });

  const userByName = new Map(USERS.map((u) => [u[2], u[0]]));
  const insEmp = db.prepare(
    `INSERT INTO employees
       (id,name,department,date_of_joining,salary,leave_balance,status,documents,user_id,position)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  const insEB = db.prepare(
    'INSERT OR IGNORE INTO employee_benefits (employee_id,benefit_id) VALUES (?,?)'
  );
  (SEED.employees || []).forEach((e, i) => {
    insEmp.run(e.id, e.name, str(e.dept), str(e.doa), str(e.sal), str(e.leave),
      str(e.status) || 'Active', str(e.docs), userByName.get(e.name) || null, i);
    bump('employees');
    for (const b of e.ben || []) {
      if (benefitId.has(b)) { insEB.run(e.id, benefitId.get(b)); bump('employee_benefits'); }
    }
  });
  activity('employees', '', SEED.emplog);

  const empByName = new Map((SEED.employees || []).map((e) => [e.name, e.id]));
  const insLeave = db.prepare(
    `INSERT INTO leave_requests
       (id,employee_id,who,department,leave_type,from_date,to_date,days,reason,cover,
        status,is_mine,has_clash,position)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const VALID_LEAVE = new Set(['waiting', 'approved', 'rejected', 'cancelled', 'recorded', 'lop']);
  (SEED.leave || []).forEach((l, i) => {
    insLeave.run(
      l.id, empByName.get(l.who) || null, l.who, str(l.dept), str(l.type),
      str(l.from), str(l.to), str(l.days), str(l.reason), str(l.cover),
      VALID_LEAVE.has(l.status) ? l.status : 'waiting',
      bool(l.mine), bool(l.clash), i
    );
    bump('leave_requests');
  });

  const insHol = db.prepare(
    'INSERT INTO holidays (id,holiday_date,name,offices,holiday_type,added_by,position) VALUES (?,?,?,?,?,?,?)'
  );
  (SEED.holidays || []).forEach((h, i) => {
    insHol.run(h.id, h.d, h.n, str(h.o), str(h.t) || 'Company-wide', str(h.a), i);
    bump('holidays');
  });

  const insHolReq = db.prepare(
    'INSERT INTO holiday_requests (id,action,requested_by,requested_at,payload,state) VALUES (?,?,?,?,?,?)'
  );
  (SEED.holreq || []).forEach((r) => {
    insHolReq.run(r.rid, ['add', 'edit', 'remove'].includes(r.action) ? r.action : 'add',
      str(r.by), str(r.at), JSON.stringify(r.h || {}), 'waiting');
    bump('holiday_requests');
  });

  // ---- audit marker ---------------------------------------------------
  db.prepare(
    `INSERT INTO audit_log (user_id,user_name,action,entity,entity_id,after_json)
     VALUES (?,?,?,?,?,?)`
  ).run(null, 'system', 'reset', 'database', '',
    JSON.stringify({ seededAt: new Date().toISOString() }));

  // ---- report ---------------------------------------------------------
  const order = Object.keys(counts).sort();
  let total = 0;
  for (const k of order) total += counts[k];
  console.log('  rows inserted:');
  for (const k of order) console.log(`    ${k.padEnd(24)} ${String(counts[k]).padStart(5)}`);
  console.log(`  total ${total} rows across ${order.length} tables`);
  console.log(`\n  sign in with any of:`);
  for (const [, email, name] of USERS) console.log(`    ${email.padEnd(32)} ${name}`);
  console.log(`  password: ${DEFAULT_PASSWORD}`);
}

if (require.main === module) {
  const run = db.transaction(seed);
  try {
    run();
  } catch (err) {
    console.error('Seed failed:', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
    process.exit(1);
  }
}

module.exports = { seed, DEFAULT_PASSWORD };
