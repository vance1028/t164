'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const { performOnlineVerify } = require('./verifications');
const { PICKUP_TYPES, VerificationError } = require('../utils/verification');

const router = express.Router();
router.use(authRequired);

router.get('/', async (req, res, next) => {
  try {
    const { elderId, mealId, status } = req.query;
    const f = {};
    if (status) f.status = status;
    if (elderId !== undefined) f.elderId = Number(elderId);
    if (mealId !== undefined) f.mealId = Number(mealId);
    return sendData(res, 200, await store.listOrders(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    return sendData(res, 200, o);
  } catch (e) { return next(e); }
});

/** POST /api/orders —— 长者订餐（同长者同餐次只能有一份有效订餐）。 */
router.post('/', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { elderId, mealId, diningType = 'DINE_IN', qty = 1 } = req.body || {};
    if (elderId === undefined || mealId === undefined) return sendError(res, 400, '长者和餐次不能为空');
    const elder = await store.getElderById(Number(elderId));
    if (!elder) return sendError(res, 400, '长者不存在');
    const meal = await store.getMealById(Number(mealId));
    if (!meal) return sendError(res, 400, '餐次不存在');
    if (meal.status !== 'PUBLISHED') return sendError(res, 409, '该餐次未开放订餐');

    const existing = await store.getOrderByElderAndMeal(Number(elderId), Number(mealId));
    if (existing) {
      if (existing.status === 'RESERVED') return sendError(res, 409, '该长者此餐次已预订');
      if (existing.status === 'SERVED') return sendError(res, 409, '该长者此餐次已核销，不能重复订餐');
    }

    const amount = meal.priceCents * (Number(qty) || 1);
    const order = await store.createOrder({
      elderId: Number(elderId), mealId: Number(mealId), diningType, qty: Number(qty) || 1,
      amountCents: amount, subsidyCents: 0, payCents: amount, status: 'RESERVED',
    });
    return sendData(res, 201, order);
  } catch (e) {
    if (e && e.code === 'ER_DUP_ENTRY') return sendError(res, 409, '该长者此餐次已存在订餐记录');
    return next(e);
  }
});

/** POST /api/orders/:id/serve —— 核销（取餐/送达），兼容旧接口：默认按本人领处理，使用订餐归属的长者身份。 */
router.post('/:id/serve', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    const meal = await store.getMealById(o.mealId);
    if (!meal) return sendError(res, 400, '关联餐次不存在');

    const result = await performOnlineVerify({
      orderId: id,
      pickupElderId: o.elderId,
      pickupType: PICKUP_TYPES.SELF,
      canteenId: meal.canteenId,
      verifierId: req.user.id,
    });
    return sendData(res, 200, result.order);
  } catch (e) {
    if (e instanceof VerificationError) return sendError(res, 409, e.message, { code: e.code });
    return next(e);
  }
});

/** POST /api/orders/:id/cancel —— 取消订餐。 */
router.post('/:id/cancel', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const o = await store.getOrderById(id);
    if (!o) return sendError(res, 404, '订餐记录不存在');
    if (o.status === 'SERVED') return sendError(res, 409, '已核销的订餐不能取消');
    return sendData(res, 200, await store.updateOrder(id, { status: 'CANCELLED' }));
  } catch (e) { return next(e); }
});

module.exports = router;
