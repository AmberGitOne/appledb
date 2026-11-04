'use strict';
/**
 * Reporting endpoints - aggregate SQL for the dashboards.
 * These are read-only and lean on the views defined in schema.sql.
 */

const express = require('express');
const { db } = require('../db');
const { wrap } = require('../lib/http');
const { requires } = require('../middleware/auth');

const router = express.Router();
const read = requires('tickets:read');

/** Headline numbers for the Command Centre. */
router.get('/summary', read, wrap(async (req, res) => {
  const row = await db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM tickets WHERE folder = 'inbox')                      AS open_tickets,
      (SELECT COUNT(*) FROM tickets WHERE folder = 'inbox' AND unread = 1)       AS unread_tickets,
      (SELECT COUNT(*) FROM tickets WHERE folder = 'inbox' AND breached = 1)     AS breached_tickets,
      (SELECT COUNT(*) FROM tickets WHERE folder = 'inbox' AND desk = '')        AS unassigned_tickets,
      (SELECT COUNT(*) FROM orders  WHERE completed = 0)                         AS open_orders,
      (SELECT COUNT(*) FROM orders  WHERE completed = 0 AND at_risk = 1)         AS orders_at_risk,
      (SELECT COUNT(*) FROM orders  WHERE completed = 0 AND cold_chain = 1)      AS cold_chain_orders,
      (SELECT COUNT(*) FROM orders  WHERE completed = 1)                         AS delivered_orders,
      (SELECT COUNT(*) FROM cases   WHERE status = 'open')                       AS open_cases,
      (SELECT COUNT(*) FROM prescriptions WHERE status IN ('queue','waiting'))   AS rx_waiting,
      (SELECT COUNT(*) FROM prescriptions WHERE sla_breached = 1)                AS rx_breached,
      (SELECT COUNT(*) FROM qa_batches WHERE status = 'review')                  AS qa_in_review,
      (SELECT COUNT(*) FROM qa_batches WHERE status = 'quarantine')              AS qa_quarantined,
      (SELECT COUNT(*) FROM qa_deviations WHERE closed_at IS NULL)               AS open_deviations,
      (SELECT COUNT(*) FROM leave_requests WHERE status = 'waiting')             AS leave_waiting,
      (SELECT COUNT(*) FROM suppliers WHERE status = 'Approved')                 AS approved_suppliers,
      (SELECT COUNT(*) FROM suppliers WHERE status = 'Blocked')                  AS blocked_suppliers,
      (SELECT COUNT(*) FROM wave_lines WHERE state <> 'shipped')                 AS wave_open,
      (SELECT COUNT(*) FROM wave_lines WHERE fefo = 'Breach')                    AS fefo_breaches
  `).get();
  res.json({ data: row });
}));

/** Workload per desk, straight from the view. */
router.get('/desks', read, wrap(async (req, res) => {
  res.json({ data: await db.prepare('SELECT * FROM v_desk_workload ORDER BY open_tickets DESC').all() });
}));

/** Ticket counts grouped by any allowed dimension. */
router.get('/tickets-by/:dimension', read, wrap(async (req, res) => {
  const ALLOWED = { channel: 'channel', desk: 'desk', priority: 'priority', folder: 'folder', status: 'status' };
  const col = ALLOWED[req.params.dimension];
  if (!col) {
    return res.status(400).json({
      error: `dimension must be one of: ${Object.keys(ALLOWED).join(', ')}`,
    });
  }
  const rows = await db.prepare(`
    SELECT ${col} AS key, COUNT(*) AS total,
           SUM(unread) AS unread, SUM(breached) AS breached
    FROM tickets WHERE folder = 'inbox'
    GROUP BY ${col} ORDER BY total DESC
  `).all();
  res.json({ data: rows });
}));

/** Order pipeline by stage. */
router.get('/pipeline', read, wrap(async (req, res) => {
  res.json({ data: await db.prepare('SELECT * FROM v_order_pipeline ORDER BY stage').all() });
}));

/** Case overview with its related record counts. */
router.get('/cases', read, wrap(async (req, res) => {
  res.json({
    data: await db.prepare('SELECT * FROM v_case_overview ORDER BY ticket_count DESC, id').all(),
  });
}));

/** Supplier certificates, nearest expiry first - the compliance watch list. */
router.get('/expiring-certificates', read, wrap(async (req, res) => {
  res.json({
    data: await db.prepare(
      'SELECT * FROM v_expiring_certificates ORDER BY expires_on LIMIT ?'
    ).all(Number(req.query.limit) || 25),
  });
}));

/** QA release progress: how far through its checks each batch is. */
router.get('/qa-progress', read, wrap(async (req, res) => {
  const rows = await db.prepare(`
    SELECT b.id, b.product, b.batch, b.status, b.supplier,
           COUNT(c.id)                 AS checks_total,
           COALESCE(SUM(c.done), 0)    AS checks_done,
           CASE WHEN COUNT(c.id) = 0 THEN 0
                ELSE ROUND(100.0 * SUM(c.done) / COUNT(c.id), 1) END AS percent
    FROM qa_batches b
    LEFT JOIN qa_checks c ON c.batch_id = b.id
    GROUP BY b.id
    ORDER BY percent DESC, b.id
  `).all();
  res.json({ data: rows });
}));

/** Leave taken per department. */
router.get('/leave-by-department', read, wrap(async (req, res) => {
  const rows = await db.prepare(`
    SELECT department,
           COUNT(*) AS requests,
           SUM(CASE WHEN status = 'waiting'  THEN 1 ELSE 0 END) AS waiting,
           SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
    FROM leave_requests
    GROUP BY department ORDER BY requests DESC
  `).all();
  res.json({ data: rows });
}));

/** Sourcing spread for an RFQ: who answered, at what landed cost. */
router.get('/sourcing/:rfqId', read, wrap(async (req, res) => {
  const rows = await db.prepare(`
    SELECT l.country, l.partner, l.state, l.landed_cost, l.lead_days, l.flag,
           s.status AS supplier_status, s.rating AS supplier_rating
    FROM rfq_lines l
    LEFT JOIN suppliers s ON s.id = l.supplier_id
    WHERE l.rfq_id = ?
    ORDER BY (l.landed_cost = 0), l.landed_cost
  `).all(req.params.rfqId);
  res.json({ data: rows });
}));

module.exports = router;
