'use strict';
/**
 * Audit trail.
 *
 * Every write that goes through the API lands here. Records are append-only:
 * nothing in the app updates or deletes an audit row. Keeping before/after
 * snapshots is what makes a change reviewable after the fact, which is the
 * point of an audit trail in a regulated setting.
 */

const { db } = require('../db');

const insert = db.prepare(`
  INSERT INTO audit_log
    (user_id, user_name, action, entity, entity_id, before_json, after_json, ip_address)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);

const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));

/**
 * @param {object}  actor  { id, name } - the signed-in user, or null
 * @param {string}  action create | update | delete | login | logout | reset
 * @param {string}  entity table or logical entity name
 */
async function record(actor, action, entity, entityId, before, after, ip) {
  await insert.run(
    actor?.id ?? null,
    actor?.name ?? 'system',
    action,
    entity,
    entityId == null ? '' : String(entityId),
    json(before),
    json(after),
    ip || ''
  );
}

/** Convenience binding for a request: audit(req)('update', 'tickets', id, before, after) */
const forRequest = (req) => (action, entity, entityId, before, after) =>
  record(req.user, action, entity, entityId, before, after, req.ip);

/** Read the trail back, newest first. */
async function list({ entity, entityId, userId, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  const sql = `
    SELECT id, user_id, user_name, action, entity, entity_id,
           before_json, after_json, ip_address, created_at
    FROM audit_log
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY id DESC
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset);
}

async function count({ entity, entityId, userId } = {}) {
  const where = [];
  const params = [];
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  const sql = `SELECT COUNT(*) AS n FROM audit_log
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const row = await db.prepare(sql).get(...params);
  return row.n;
}

module.exports = { record, forRequest, list, count };
