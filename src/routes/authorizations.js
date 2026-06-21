'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const { nowIso } = require('../utils/verification');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const { elderId, proxyIdCode, status } = req.query;
    const f = {};
    if (elderId !== undefined) f.elderId = Number(elderId);
    if (proxyIdCode) f.proxyIdCode = proxyIdCode;
    if (status) f.status = status;
    return sendData(res, 200, await store.listAuthorizations(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const a = await store.getAuthorizationById(id);
    if (!a) return sendError(res, 404, '代领授权不存在');
    return sendData(res, 200, a);
  } catch (e) { return next(e); }
});

router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { elderId, proxyName, proxyPhone, proxyIdCode, validFrom, validUntil, note } = req.body || {};
    if (!elderId || !proxyName || !proxyIdCode || !validFrom || !validUntil) {
      return sendError(res, 400, '长者、代领人姓名/证件号、有效期起止均不能为空');
    }
    const elder = await store.getElderById(Number(elderId));
    if (!elder) return sendError(res, 400, '长者不存在');
    const auth = await store.createAuthorization({
      elderId: Number(elderId),
      authorizedBy: req.user.id,
      proxyName, proxyPhone: proxyPhone || '', proxyIdCode,
      validFrom, validUntil, note: note || '', status: 'ACTIVE',
    });
    return sendData(res, 201, auth);
  } catch (e) { return next(e); }
});

router.patch('/:id', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const a = await store.getAuthorizationById(id);
    if (!a) return sendError(res, 404, '代领授权不存在');
    const { validFrom, validUntil, note, proxyName, proxyPhone } = req.body || {};
    const updated = await store.updateAuthorization(id, { validFrom, validUntil, note, proxyName, proxyPhone });
    return sendData(res, 200, updated);
  } catch (e) { return next(e); }
});

router.post('/:id/revoke', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const a = await store.getAuthorizationById(id);
    if (!a) return sendError(res, 404, '代领授权不存在');
    if (a.status !== 'ACTIVE') return sendError(res, 409, '该授权已非有效状态');
    const revoked = await store.revokeAuthorization(id, req.user.id, nowIso());
    return sendData(res, 200, revoked);
  } catch (e) { return next(e); }
});

module.exports = router;
