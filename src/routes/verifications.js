'use strict';

const express = require('express');
const store = require('../data/store');
const { authRequired, requireRole } = require('../auth');
const { sendData, sendError, parseId } = require('../utils/http');
const {
  PICKUP_TYPES, VERIFY_CHANNELS, VerificationError, nowIso, RESOLUTIONS,
  validateOnlineVerify, resolveOfflineConflict,
  buildVerificationRecord, summarizeBatch, CONFLICT_TYPES,
} = require('../utils/verification');

const router = express.Router();
router.use(authRequired);

async function performOnlineVerify({ orderId, pickupElderId, pickupType, proxyIdCode, canteenId, verifierId, verifiedAt }) {
  return store.withTransaction(async (conn) => {
    const order = await store.getOrderById(orderId, conn);
    const at = verifiedAt || nowIso();

    if (!order) throw new VerificationError(CONFLICT_TYPES.NO_ORDER, '订餐不存在');

    const meal = await store.getMealById(order.mealId, conn);
    if (!meal) throw new VerificationError('NO_MEAL', '餐次不存在');

    if (meal.canteenId !== canteenId) {
      throw new VerificationError('CANTEEN_MISMATCH', `该餐次属于助餐点 #${meal.canteenId}，与当前助餐点 #${canteenId} 不匹配`);
    }

    const elder = pickupElderId ? await store.getElderById(pickupElderId, conn) : null;

    let proxyAuthorization = null;
    if (pickupType === PICKUP_TYPES.PROXY) {
      if (!proxyIdCode) {
        throw new VerificationError('NO_PROXY_INFO', '代领核销必须提供代领人证件号');
      }
      proxyAuthorization = await store.findActiveAuthorization(order.elderId, proxyIdCode, at, conn);
    }

    const existingVerification = await store.getValidVerificationByElderAndMeal(order.elderId, order.mealId, conn);

    validateOnlineVerify({
      order, pickupElderId, pickupType, proxyAuthorization, at, existingVerification, elder,
    });

    await store.updateOrder(orderId, { status: 'SERVED' }, conn);

    const record = buildVerificationRecord({
      order, meal, pickupType, elder, proxyAuthorization,
      proxyIdCode, verifierId, verifyChannel: VERIFY_CHANNELS.ONLINE,
      verifiedAt: at, status: 'VALID',
    });
    const verification = await store.createVerification(record, conn);
    const updatedOrder = await store.getOrderById(orderId, conn);
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

router.post('/verify', requireRole('ADMIN', 'OPERATOR'), async (req, res, next) => {
  try {
    const { orderId, elderCode, pickupType = PICKUP_TYPES.SELF, proxyIdCode, proxyName, canteenId, verifiedAt } = req.body || {};
    if (!orderId) return sendError(res, 400, '订单号不能为空');
    if (!canteenId) return sendError(res, 400, '助餐点不能为空');

    let pickupElderId = null;
    if (pickupType === PICKUP_TYPES.SELF) {
      if (!elderCode) return sendError(res, 400, '本人取餐必须提供长者编号（刷卡/扫码）');
      const elder = await store.getElderByCode(elderCode);
      if (!elder) return sendError(res, 400, '取餐长者不存在');
      pickupElderId = elder.id;
    } else if (pickupType === PICKUP_TYPES.PROXY) {
      if (!proxyIdCode) return sendError(res, 400, '代领取餐必须提供代领人证件号');
    } else {
      return sendError(res, 400, '取餐方式无效');
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

    const validationErrors = [];
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i];
      if (!rec.offlineToken) validationErrors.push(`第 ${i + 1} 条缺少 offlineToken`);
      if (!rec.orderId) validationErrors.push(`第 ${i + 1} 条缺少 orderId`);
      if (!rec.verifiedAt) validationErrors.push(`第 ${i + 1} 条缺少 verifiedAt`);
      if (rec.pickupType === PICKUP_TYPES.PROXY && !rec.proxyIdCode) {
        validationErrors.push(`第 ${i + 1} 条为代领但缺少 proxyIdCode`);
      }
    }
    if (validationErrors.length > 0) {
      return sendError(res, 400, '离线记录校验失败', { errors: validationErrors });
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
        const result = await store.withTransaction(async (conn) => {
          const order = rec.orderId ? await store.getOrderById(rec.orderId, conn) : null;
          const meal = order ? await store.getMealById(order.mealId, conn) : null;
          const existingByToken = await store.getVerificationByOfflineToken(rec.offlineToken, conn);
          const existingByElderMeal = order
            ? await store.getValidVerificationByElderAndMeal(order.elderId, order.mealId, conn)
            : null;

          let resolution = resolveOfflineConflict({
            order, offlineRecord: rec, existingByToken, existingByElderMeal, at,
          });

          const pickupType = rec.pickupType === PICKUP_TYPES.PROXY ? PICKUP_TYPES.PROXY : PICKUP_TYPES.SELF;
          let proxyAuthorization = null;

          if ((resolution.resolution === RESOLUTIONS.ACCEPT || resolution.resolution === RESOLUTIONS.SUPERSEDED)
              && pickupType === PICKUP_TYPES.PROXY && order) {
            proxyAuthorization = await store.findActiveAuthorization(
              order.elderId, rec.proxyIdCode, rec.verifiedAt || at, conn
            );
            if (!proxyAuthorization) {
              resolution = {
                resolution: RESOLUTIONS.REJECT,
                conflictType: 'OFFLINE_PROXY_NO_AUTH',
                note: `离线代领记录无有效授权（代领人=${rec.proxyIdCode}），拒绝`,
              };
            }
          }

          const itemResult = {
            offlineToken: rec.offlineToken,
            orderId: order ? order.id : rec.orderId,
            resolution: resolution.resolution,
            conflictType: resolution.conflictType || null,
            note: resolution.note || null,
          };

          if (resolution.resolution === RESOLUTIONS.ACCEPT || resolution.resolution === RESOLUTIONS.SUPERSEDED) {
            if (meal && meal.canteenId !== Number(canteenId)) {
              await store.createConflict({
                syncBatchId: batch.id,
                orderId: order.id,
                offlineToken: rec.offlineToken,
                offlineVerifiedAt: rec.verifiedAt || at,
                existingStatus: order.status,
                existingVerifiedAt: resolution.existingVerification ? resolution.existingVerification.verifiedAt : null,
                conflictType: 'OFFLINE_CANTEEN_MISMATCH',
                resolution: RESOLUTIONS.REJECT,
                note: `离线核销助餐点 ${canteenId} 与订餐归属助餐点 ${meal.canteenId} 不一致，拒绝`,
              }, conn);
              itemResult.resolution = RESOLUTIONS.REJECT;
              itemResult.conflictType = 'OFFLINE_CANTEEN_MISMATCH';
              itemResult.note = `助餐点不匹配（期望=${meal.canteenId}，实际=${canteenId}）`;
              return itemResult;
            }

            if (resolution.resolution === RESOLUTIONS.SUPERSEDED && resolution.existingVerification) {
              await store.updateVerificationStatus(
                resolution.existingVerification.id,
                'SUPERSEDED',
                `被离线记录 ${rec.offlineToken} 覆盖：${resolution.note}`,
                conn
              );
            }

            if (order.status === 'RESERVED') {
              await store.updateOrder(order.id, { status: 'SERVED' }, conn);
            }

            const verificationRecord = buildVerificationRecord({
              order, meal, pickupType,
              proxyAuthorization, proxyIdCode: rec.proxyIdCode, proxyName: rec.proxyName,
              verifierId: rec.verifierId ?? null, verifyChannel: VERIFY_CHANNELS.OFFLINE,
              offlineToken: rec.offlineToken,
              verifiedAt: rec.verifiedAt || at,
              syncedAt: at, syncBatchId: batch.id,
              status: 'VALID',
            });
            const created = await store.createVerification(verificationRecord, conn);
            itemResult.verificationId = created.id;

            if (resolution.conflictType && resolution.resolution === RESOLUTIONS.SUPERSEDED) {
              await store.createConflict({
                syncBatchId: batch.id,
                orderId: order.id,
                offlineToken: rec.offlineToken,
                offlineVerifiedAt: rec.verifiedAt || at,
                existingStatus: 'SERVED',
                existingVerifiedAt: resolution.existingVerification ? resolution.existingVerification.verifiedAt : null,
                conflictType: resolution.conflictType,
                resolution: RESOLUTIONS.SUPERSEDED,
                note: resolution.note,
              }, conn);
            }
          } else if (resolution.resolution === RESOLUTIONS.REJECT) {
            await store.createConflict({
              syncBatchId: batch.id,
              orderId: order ? order.id : null,
              unknownOrderId: order ? null : String(rec.orderId),
              offlineToken: rec.offlineToken,
              offlineVerifiedAt: rec.verifiedAt || at,
              existingStatus: order ? order.status : 'UNKNOWN',
              existingVerifiedAt: resolution.existingVerification ? resolution.existingVerification.verifiedAt : null,
              conflictType: resolution.conflictType || 'UNKNOWN',
              resolution: RESOLUTIONS.REJECT,
              note: resolution.note,
            }, conn);
          }

          return itemResult;
        });
        results.push(result);
      } catch (err) {
        const conflictNote = err.message || '处理异常';
        try {
          await store.createConflict({
            syncBatchId: batch.id,
            orderId: null,
            unknownOrderId: rec.orderId != null ? String(rec.orderId) : null,
            offlineToken: rec.offlineToken || null,
            offlineVerifiedAt: rec.verifiedAt || at,
            existingStatus: 'ERROR',
            conflictType: 'PROCESS_ERROR',
            resolution: RESOLUTIONS.REJECT,
            note: conflictNote,
          });
        } catch (_) { /* ignore */ }
        results.push({
          offlineToken: rec.offlineToken || null,
          orderId: rec.orderId || null,
          resolution: 'ERROR',
          conflictType: 'PROCESS_ERROR',
          note: conflictNote,
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

router.get('/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    const v = await store.getVerificationById(id);
    if (!v) return sendError(res, 404, '核销记录不存在');
    return sendData(res, 200, v);
  } catch (e) { return next(e); }
});

module.exports = { router, performOnlineVerify };
