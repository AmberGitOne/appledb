'use strict';
/** POST /api/auth/login | POST /api/auth/logout | GET /api/auth/me */

const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const audit = require('../lib/audit');
const { wrap, badRequest, unauthorized } = require('../lib/http');
const { sign, hydrate, REQUIRE_AUTH } = require('../middleware/auth');
const { DEMO_PASSWORD, DEMO_LOGIN } = require('../lib/demo');

const router = express.Router();

const selByEmail = db.prepare(
  'SELECT id, email, name, password_hash, active FROM users WHERE lower(email) = lower(?)'
);

router.post('/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) throw badRequest('email and password are required');

  const row = selByEmail.get(String(email).trim());
  // Same message either way: do not reveal which accounts exist.
  if (!row || !row.active) throw unauthorized('Email or password is incorrect');
  if (!bcrypt.compareSync(String(password), row.password_hash)) {
    throw unauthorized('Email or password is incorrect');
  }

  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(row.id);
  const user = hydrate(row.id);
  const token = sign(user);

  audit.record(user, 'login', 'users', user.id, null, { email: user.email }, req.ip);

  res.cookie('token', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000,
  });

  res.json({ token, user: publicUser(user) });
}));

/**
 * GET /api/auth/accounts - the sign-in page's account picker.
 *
 * Public, necessarily: it is read before anyone has a token. That means it
 * discloses who exists, so it answers with nothing at all unless this is a
 * demo build. `password` is the shared fixture, sent so the picker can fill
 * the form in; it is never used server-side - /login is still the only way
 * in, and it still checks the hash.
 */
router.get('/accounts', wrap((req, res) => {
  if (!DEMO_LOGIN) {
    return res.json({ demo: false, requireAuth: REQUIRE_AUTH, data: [] });
  }
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.desk, u.job_title AS jobTitle, u.avatar,
           u.role_id AS roleId, r.name AS roleName, r.description AS roleDescription
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1
    ORDER BY r.id, u.name
  `).all();
  res.json({
    demo: true,
    requireAuth: REQUIRE_AUTH,
    password: DEMO_PASSWORD,
    data: rows,
  });
}));

router.post('/logout', wrap((req, res) => {
  if (req.user) audit.record(req.user, 'logout', 'users', req.user.id, null, null, req.ip);
  res.clearCookie('token');
  res.json({ ok: true });
}));

router.get('/me', wrap((req, res) => {
  if (!req.user) throw unauthorized();
  res.json({ user: publicUser(req.user), requireAuth: REQUIRE_AUTH });
}));

/** Everyone who can be assigned work - used by the UI's "view as" switcher. */
router.get('/users', wrap((req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.desk, u.job_title, u.grade, u.avatar,
           r.id AS role_id, r.name AS role_name
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.active = 1
    ORDER BY u.name
  `).all();
  res.json({ data: rows });
}));

/** Roles with the permissions attached - backs the Roles & Permissions screen. */
router.get('/roles', wrap((req, res) => {
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const perms = db.prepare(`
    SELECT rp.role_id, p.id, p.resource, p.action
    FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
    ORDER BY p.resource, p.action
  `).all();
  const byRole = new Map();
  for (const p of perms) {
    if (!byRole.has(p.role_id)) byRole.set(p.role_id, []);
    byRole.get(p.role_id).push({ id: p.id, resource: p.resource, action: p.action });
  }
  res.json({
    data: roles.map((r) => ({ ...r, permissions: byRole.get(r.id) || [] })),
  });
}));

function publicUser(u) {
  return {
    id: u.id, email: u.email, name: u.name, desk: u.desk,
    jobTitle: u.job_title, grade: u.grade, avatar: u.avatar,
    role: { id: u.role_id, name: u.role_name },
    permissions: u.permissions || [],
  };
}

module.exports = router;
