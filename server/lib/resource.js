'use strict';
/**
 * REST resource factory.
 *
 * Builds a conventional CRUD router over one table. Every value reaching SQL
 * goes through a bound parameter; the only interpolated strings are column
 * and table names, and those are validated against a whitelist taken from the
 * table definition, so a query string cannot reach the SQL text.
 *
 *   GET    /            list    ?page= &limit= &sort= &order= &q= &<column>=
 *   GET    /:id         read one (optionally with child collections)
 *   POST   /            create
 *   PATCH  /:id         partial update
 *   DELETE /:id         delete
 */

const express = require('express');
const { db } = require('../db');
const audit = require('./audit');
const { wrap, badRequest, notFound, conflict, pagination } = require('./http');
const { requires } = require('../middleware/auth');

/**
 * Columns that really exist on the table - the whitelist for identifiers.
 *
 * Memoised, because it is read on every request now that it cannot be
 * resolved while the router is being built.
 */
const columnCache = new Map();

function columnsOf(table) {
  if (!columnCache.has(table)) {
    columnCache.set(
      table,
      db.prepare(`PRAGMA table_info(${table})`).all().then((rows) => {
        const names = rows.map((c) => c.name);
        if (!names.length) throw new Error(`resource(): unknown table "${table}"`);
        return names;
      })
    );
  }
  return columnCache.get(table);
}

/**
 * Every resource's column lookup, so the server can resolve them all at
 * startup. Without this a mistyped table name would only surface on the
 * first request that touched it, rather than on boot as it used to.
 */
const warmers = [];
const warmup = () => Promise.all(warmers.map((fn) => fn()));

/**
 * @param {object} cfg
 *   table     table name
 *   pk        primary key column (default 'id')
 *   entity    audit/permission name (default = table)
 *   searchable columns scanned by ?q=
 *   filterable columns accepted as exact-match query params
 *   defaultSort column used when ?sort= is absent
 *   children  { key: { table, fk, orderBy } } expanded on GET /:id
 *   generateId (body) => string, when the client may omit the pk
 */
function resource(cfg) {
  const {
    table,
    pk = 'id',
    entity = table,
    searchable = [],
    filterable = [],
    defaultSort = pk,
    children = {},
    generateId = null,
  } = cfg;

  let meta = null;
  async function describe() {
    if (meta) return meta;
    const COLUMNS = await columnsOf(table);
    const isColumn = (c) => COLUMNS.includes(c);
    meta = {
      COLUMNS,
      isColumn,
      safeSearchable: searchable.filter(isColumn),
      safeFilterable: filterable.filter(isColumn),
    };
    return meta;
  }
  warmers.push(describe);

  const router = express.Router();

  // ---- list ----------------------------------------------------------
  router.get('/', requires(`${entity}:read`), wrap(async (req, res) => {
    const { isColumn, safeSearchable, safeFilterable } = await describe();
    const where = [];
    const params = [];

    for (const col of safeFilterable) {
      const v = req.query[col];
      if (v === undefined || v === '') continue;
      if (Array.isArray(v)) {
        where.push(`${col} IN (${v.map(() => '?').join(',')})`);
        params.push(...v);
      } else {
        where.push(`${col} = ?`);
        params.push(v);
      }
    }

    if (req.query.q && safeSearchable.length) {
      where.push('(' + safeSearchable.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
      const like = `%${req.query.q}%`;
      for (let i = 0; i < safeSearchable.length; i++) params.push(like);
    }

    const sort = isColumn(req.query.sort) ? req.query.sort : defaultSort;
    const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const { limit, offset, page } = pagination(req.query);
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const { n: total } = await db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${clause}`)
      .get(...params);

    const rows = await db.prepare(
      `SELECT * FROM ${table} ${clause} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.json({
      data: rows,
      meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
    });
  }));

  // ---- read one ------------------------------------------------------
  router.get('/:id', requires(`${entity}:read`), wrap(async (req, res) => {
    const row = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
    if (!row) throw notFound(`${entity} ${req.params.id} not found`);

    for (const [key, child] of Object.entries(children)) {
      row[key] = await db.prepare(
        `SELECT * FROM ${child.table} WHERE ${child.fk} = ? ORDER BY ${child.orderBy || 'id'}`
      ).all(req.params.id);
    }
    res.json({ data: row });
  }));

  // ---- create --------------------------------------------------------
  router.post('/', requires(`${entity}:create`), wrap(async (req, res) => {
    const { COLUMNS } = await describe();
    const body = req.body || {};
    const row = {};
    for (const col of COLUMNS) {
      if (body[col] !== undefined) row[col] = normalise(body[col]);
    }
    if (!row[pk] && generateId) row[pk] = generateId(body);
    if (!row[pk]) throw badRequest(`${pk} is required`);

    const exists = await db.prepare(`SELECT 1 FROM ${table} WHERE ${pk} = ?`).get(row[pk]);
    if (exists) throw conflict(`${entity} ${row[pk]} already exists`);

    const cols = Object.keys(row);
    if (!cols.length) throw badRequest('no recognised fields in the request body');

    try {
      await db.prepare(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
      ).run(...cols.map((c) => row[c]));
    } catch (err) {
      throw translate(err);
    }

    const saved = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(row[pk]);
    await audit.forRequest(req)('create', entity, row[pk], null, saved);
    res.status(201).json({ data: saved });
  }));

  // ---- update --------------------------------------------------------
  router.patch('/:id', requires(`${entity}:update`), wrap(async (req, res) => {
    const { COLUMNS } = await describe();
    const before = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
    if (!before) throw notFound(`${entity} ${req.params.id} not found`);

    const body = req.body || {};
    const patch = {};
    for (const col of COLUMNS) {
      if (col === pk) continue;
      if (body[col] === undefined) continue;
      const val = normalise(body[col]);
      if (String(before[col] ?? '') !== String(val ?? '')) patch[col] = val;
    }

    if (!Object.keys(patch).length) {
      return res.json({ data: before, changed: false });
    }

    const cols = Object.keys(patch);
    try {
      await db.prepare(
        `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE ${pk} = ?`
      ).run(...cols.map((c) => patch[c]), req.params.id);
    } catch (err) {
      throw translate(err);
    }

    const after = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
    const prev = {};
    for (const c of cols) prev[c] = before[c];
    await audit.forRequest(req)('update', entity, req.params.id, prev, patch);
    res.json({ data: after, changed: true });
  }));

  // ---- delete --------------------------------------------------------
  router.delete('/:id', requires(`${entity}:delete`), wrap(async (req, res) => {
    const before = await db.prepare(`SELECT * FROM ${table} WHERE ${pk} = ?`).get(req.params.id);
    if (!before) throw notFound(`${entity} ${req.params.id} not found`);
    try {
      await db.prepare(`DELETE FROM ${table} WHERE ${pk} = ?`).run(req.params.id);
    } catch (err) {
      throw translate(err);
    }
    await audit.forRequest(req)('delete', entity, req.params.id, before, null);
    res.json({ ok: true, deleted: req.params.id });
  }));

  return router;
}

/** JS values -> values SQLite will accept. */
function normalise(v) {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/** Turn SQLite constraint errors into useful 4xx responses. */
function translate(err) {
  const m = String(err.message || '');
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || m.includes('UNIQUE constraint')) {
    return conflict('That value is already taken', { sqlite: m });
  }
  if (err.code === 'SQLITE_CONSTRAINT_CHECK' || m.includes('CHECK constraint')) {
    return badRequest('A field is outside its allowed set of values', { sqlite: m });
  }
  if (err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' || m.includes('FOREIGN KEY')) {
    return conflict('That record is referenced by other rows, or points at one that does not exist',
      { sqlite: m });
  }
  if (err.code === 'SQLITE_CONSTRAINT_NOTNULL' || m.includes('NOT NULL')) {
    return badRequest('A required field was missing', { sqlite: m });
  }
  return err;
}

module.exports = { resource, columnsOf, warmup };
