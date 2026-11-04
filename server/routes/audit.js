'use strict';
/** GET /api/audit - read the append-only audit trail. */

const express = require('express');
const auditLog = require('../lib/audit');
const { wrap, pagination } = require('../lib/http');
const { requires } = require('../middleware/auth');

const router = express.Router();

router.get('/', requires('audit:read'), wrap(async (req, res) => {
  const { limit, offset, page } = pagination(req.query, 100);
  const filter = {
    entity: req.query.entity,
    entityId: req.query.entityId,
    userId: req.query.userId,
  };
  const found = await auditLog.list({ ...filter, limit, offset });
  const rows = found.map((r) => ({
    ...r,
    before: safeParse(r.before_json),
    after: safeParse(r.after_json),
  }));
  const total = await auditLog.count(filter);
  res.json({
    data: rows,
    meta: { total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) },
  });
}));

function safeParse(v) {
  if (v == null) return null;
  try { return JSON.parse(v); } catch { return v; }
}

module.exports = router;
