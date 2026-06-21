'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const {
  PICKUP_TYPES, VERIFY_CHANNELS, VerificationError, nowIso,
  validateOnlineVerify, resolveOfflineConflict,
  buildVerificationRecord, summarizeBatch, RESOLUTIONS,
} = require('../utils/verification');

const router = express.Router();
router.use(authRequired);

async function performOnlineVerify({ orderId, pickupElderId, pickupType, proxyIdCode, canteenId, verifierId, verifiedAt }) {
  return store.withTransaction(async () => {
    const order = await store.getOrderById(orderId);
    const at = verifiedAt || nowIso();

    const meal = order ? await store.getMealById(order.mealId) : null;
    const elder = pickupElderId ? await store.getElderById(pickupElderId) : null;

    let proxyAuthorization = null;
    if (pickupType === PICKUP_TYPES.PROXY) {
      if (!order || !proxyIdCode) {
        throw new VerificationError('NO_PROXY_INFO', '代领核销必须提供代领人证件号');
      }
      proxyAuthorization = await store.findActiveAuthorization(order.elderId, proxyIdCode, at);
    }

    const existingVerification = order
      ? await store.getValidVerificationByElderAndMeal(order.elderId, order.mealId)
      : null;

    validateOnlineVerify({
      order, pickupElderId, pickupType, proxyAuthorization, at, existingVerification, elder,
    });

    await store.updateOrder(orderId, { status: 'SERVED' });

    const record = buildVerificationRecord({
      order, meal, pickupType, elder, proxyAuthorization,
      proxyIdCode, verifierId, verifyChannel: VERIFY_CHANNELS.ONLINE,
      verifiedAt: at, status: 'VALID',
    });
    const verification = await store.createVerification(record);
    const updatedOrder = await store.getOrderById(orderId);
    return { order: updatedOrder, verification };
  });
}

router.get('/', async (req, res, next) => {
  try {
    const { orderId, elderId, mealId, canteenId, status, offlineToken } = req.query;
    const f = {};
    if (orderId !== undefined) f.orderId = Number(orderId);
    if (elderId !== undefined) f.elderId = Number(elderId);
    if (mealId !== undefined) f.mealId = Number(mealId);
    if (canteenId !== undefined) f.canteenId = Number(canteenId);
    if (status) f.status = status;
    if (offlineToken) f.offlineToken = offlineToken;
    return sendData(res, 200, await store.listVerifications(f));
  } catch (e) { return next(e); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const v = await store.getVerificationById(id);
    if (!v) return sendError(res, 404, '核销记录不存在');
    return sendData(res, 200, v);
  } catch (e) { return next(e); }
});

router.post('/verify', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { orderId, elderCode, pickupType = PICKUP_TYPES.SELF, proxyIdCode, proxyName, canteenId, verifiedAt } = req.body || {};
    if (!orderId) return sendError(res, 400, '订单号不能为空');
    if (!canteenId) return sendError(res, 400, '助餐点不能为空');

    let pickupElderId = null;
    if (pickupType === PICKUP_TYPES.SELF) {
      if (!elderCode) return sendError(res, 400, '本人取餐必须提供长者编号');
      const elder = await store.getElderByCode(elderCode);
      if (!elder) return sendError(res, 400, '取餐长者不存在');
      pickupElderId = elder.id;
    }

    const result = await performOnlineVerify({
      orderId: Number(orderId), pickupElderId, pickupType, proxyIdCode,
      canteenId: Number(canteenId), verifierId: req.user.id, verifiedAt,
    });
    return sendData(res, 200, result);
  } catch (e) {
    if (e instanceof VerificationError) return sendError(res, 409, e.message, { code: e.code });
    return next(e);
  }
});

router.post('/offline-sync', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { canteenId, batchCode, records } = req.body || {};
    if (!canteenId || !batchCode || !Array.isArray(records) || records.length === 0) {
      return sendError(res, 400, '助餐点、批次号、核销记录列表均不能为空');
    }

    const existingBatch = await store.getSyncBatchByCode(batchCode);
    if (existingBatch) {
      return sendData(res, 200, {
        batch: existingBatch,
        note: '该批次已处理过，幂等返回',
      });
    }

    const batch = await store.createSyncBatch({
      canteenId: Number(canteenId),
      operatorId: req.user.id,
      batchCode,
      recordCount: records.length,
      status: 'PROCESSING',
    });

    const at = nowIso();
    const results = [];

    for (const rec of records) {
      try {
        const result = await store.withTransaction(async () => {
          const order = rec.orderId ? await store.getOrderById(rec.orderId) : null;
          const meal = order ? await store.getMealById(order.mealId) : null;
          const existingByToken = rec.offlineToken ? await store.getVerificationByOfflineToken(rec.offlineToken) : null;
          const existingByElderMeal = order
            ? await store.getValidVerificationByElderAndMeal(order.elderId, order.mealId)
            : null;

          const resolution = resolveOfflineConflict({
            order, offlineRecord: rec, existingByToken, existingByElderMeal, at,
          });

          const itemResult = {
            offlineToken: rec.offlineToken || null,
            orderId: order ? order.id : (rec.orderId || null),
            resolution: resolution.resolution,
            conflictType: resolution.conflictType || null,
            note: resolution.note || null,
          };

          if (resolution.resolution === RESOLUTIONS.ACCEPT || resolution.resolution === RESOLUTIONS.SUPERSEDED) {
            if (resolution.resolution === RESOLUTIONS.SUPERSEDED && resolution.existingVerification) {
              await store.updateVerificationStatus(
                resolution.existingVerification.id,
                'SUPERSEDED',
                `被离线记录 ${rec.offlineToken || ''} 覆盖：${resolution.note}`
              );
            }

            if (order && order.status === 'RESERVED') {
              await store.updateOrder(order.id, { status: 'SERVED' });
            }

            const pickupType = rec.pickupType && rec.pickupType === PICKUP_TYPES.PROXY ? PICKUP_TYPES.PROXY : PICKUP_TYPES.SELF;
            let proxyAuthorization = null;
            if (pickupType === PICKUP_TYPES.PROXY && rec.proxyIdCode && order) {
              proxyAuthorization = await store.findActiveAuthorization(order.elderId, rec.proxyIdCode, rec.verifiedAt || at);
            }

            const verificationRecord = buildVerificationRecord({
              order, meal, pickupType,
              proxyAuthorization, proxyIdCode: rec.proxyIdCode, proxyName: rec.proxyName,
              verifierId: rec.verifierId ?? null, verifyChannel: VERIFY_CHANNELS.OFFLINE,
              offlineToken: rec.offlineToken || null,
              verifiedAt: rec.verifiedAt || at,
              syncedAt: at, syncBatchId: batch.id,
              status: 'VALID',
            });
            const created = await store.createVerification(verificationRecord);
            itemResult.verificationId = created.id;
          } else if (resolution.resolution === RESOLUTIONS.REJECT && resolution.conflictType) {
            if (order) {
              await store.createConflict({
                syncBatchId: batch.id,
                orderId: order.id,
                offlineToken: rec.offlineToken || null,
                offlineVerifiedAt: rec.verifiedAt || at,
                existingStatus: order.status,
                existingVerifiedAt: resolution.existingVerification ? resolution.existingVerification.verifiedAt : null,
                conflictType: resolution.conflictType,
                resolution: RESOLUTIONS.REJECT,
                note: resolution.note,
              });
            }
          }

          if (resolution.conflictType && resolution.resolution === RESOLUTIONS.SUPERSEDED && order) {
            await store.createConflict({
              syncBatchId: batch.id,
              orderId: order.id,
              offlineToken: rec.offlineToken || null,
              offlineVerifiedAt: rec.verifiedAt || at,
              existingStatus: 'SERVED',
              existingVerifiedAt: resolution.existingVerification ? resolution.existingVerification.verifiedAt : null,
              conflictType: resolution.conflictType,
              resolution: RESOLUTIONS.SUPERSEDED,
              note: resolution.note,
            });
          }

          return itemResult;
        });
        results.push(result);
      } catch (err) {
        results.push({
          offlineToken: rec.offlineToken || null,
          orderId: rec.orderId || null,
          resolution: 'ERROR',
          conflictType: 'PROCESS_ERROR',
          note: err.message,
        });
      }
    }

    const summary = summarizeBatch(results);
    await store.updateSyncBatch(batch.id, {
      status: 'PROCESSED',
      processedAt: nowIso(),
      summary: JSON.stringify(summary),
    });
    const finalBatch = await store.getSyncBatchById(batch.id);

    return sendData(res, 200, { batch: finalBatch, summary, results });
  } catch (e) { return next(e); }
});

router.get('/batches', async (req, res, next) => {
  try {
    const { canteenId, status } = req.query;
    const f = {};
    if (canteenId !== undefined) f.canteenId = Number(canteenId);
    if (status) f.status = status;
    return sendData(res, 200, await store.listSyncBatches(f));
  } catch (e) { return next(e); }
});

router.get('/batches/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const b = await store.getSyncBatchById(id);
    if (!b) return sendError(res, 404, '补传批次不存在');
    return sendData(res, 200, b);
  } catch (e) { return next(e); }
});

router.get('/conflicts', async (req, res, next) => {
  try {
    const { orderId, syncBatchId, conflictType } = req.query;
    const f = {};
    if (orderId !== undefined) f.orderId = Number(orderId);
    if (syncBatchId !== undefined) f.syncBatchId = Number(syncBatchId);
    if (conflictType) f.conflictType = conflictType;
    return sendData(res, 200, await store.listConflicts(f));
  } catch (e) { return next(e); }
});

router.get('/conflicts/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const c = await store.getConflictById(id);
    if (!c) return sendError(res, 404, '冲突记录不存在');
    return sendData(res, 200, c);
  } catch (e) { return next(e); }
});

module.exports = { router, performOnlineVerify };
