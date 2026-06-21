'use strict';

const CONFLICT_TYPES = {
  DUPLICATE_TOKEN: 'DUPLICATE_TOKEN',
  ORDER_CANCELLED: 'ORDER_CANCELLED',
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  ALREADY_SERVED: 'ALREADY_SERVED',
  ELDER_MEAL_DUPLICATE: 'ELDER_MEAL_DUPLICATE',
  OWNER_MISMATCH: 'OWNER_MISMATCH',
  NO_ORDER: 'NO_ORDER',
};

const RESOLUTIONS = {
  ACCEPT: 'ACCEPT',
  REJECT: 'REJECT',
  SUPERSEDED: 'SUPERSEDED',
};

const PICKUP_TYPES = { SELF: 'SELF', PROXY: 'PROXY' };
const VERIFY_CHANNELS = { ONLINE: 'ONLINE', OFFLINE: 'OFFLINE' };

class VerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VerificationError';
    this.code = code;
  }
}

function nowIso() { return new Date().toISOString(); }

function toTs(d) {
  if (!d) return 0;
  if (typeof d === 'string') return Date.parse(d);
  if (d instanceof Date) return d.getTime();
  return 0;
}

function checkOwnership(order, elderId) {
  return !!(order && order.elderId === elderId);
}

function checkOrderStatusForVerify(order) {
  if (!order) return { ok: false, code: CONFLICT_TYPES.NO_ORDER, msg: '订餐不存在' };
  if (order.status === 'CANCELLED') return { ok: false, code: CONFLICT_TYPES.ORDER_CANCELLED, msg: '订餐已取消' };
  if (order.status !== 'RESERVED') return { ok: false, code: CONFLICT_TYPES.ORDER_EXPIRED, msg: `订餐状态不可核销（${order.status}）` };
  return { ok: true };
}

function checkNoDuplicateServe(existingVerification) {
  if (!existingVerification) return { ok: true };
  if (existingVerification.status === 'VALID') {
    return {
      ok: false,
      code: CONFLICT_TYPES.ALREADY_SERVED,
      msg: '该餐次已核销，不能重复领取',
      existing: existingVerification,
    };
  }
  return { ok: true };
}

function checkSelfPickup(elder, elderId) {
  if (!elder) return { ok: false, code: 'ELDER_NOT_FOUND', msg: '取餐长者不存在' };
  if (elder.id !== elderId) return { ok: false, code: CONFLICT_TYPES.OWNER_MISMATCH, msg: '取餐人与订餐归属不匹配（防冒领）' };
  return { ok: true };
}

function checkProxyAuthorization(authorization, at) {
  if (!authorization) return { ok: false, code: 'NO_AUTHORIZATION', msg: '未找到有效的代领授权' };
  if (authorization.status !== 'ACTIVE') return { ok: false, code: 'AUTH_REVOKED', msg: '代领授权已被撤销' };
  const ts = toTs(at);
  if (ts < toTs(authorization.validFrom)) return { ok: false, code: 'AUTH_NOT_STARTED', msg: '代领授权尚未生效' };
  if (ts > toTs(authorization.validUntil)) return { ok: false, code: 'AUTH_EXPIRED', msg: '代领授权已过期' };
  return { ok: true };
}

function validateOnlineVerify(ctx) {
  const { order, pickupElderId, pickupType, proxyAuthorization, at, existingVerification, elder } = ctx;

  const statusCheck = checkOrderStatusForVerify(order);
  if (!statusCheck.ok) throw new VerificationError(statusCheck.code, statusCheck.msg);

  if (pickupType === PICKUP_TYPES.SELF) {
    if (!checkOwnership(order, pickupElderId)) {
      throw new VerificationError(CONFLICT_TYPES.OWNER_MISMATCH, '取餐人与订餐归属不匹配（防冒领）');
    }
    const selfCheck = checkSelfPickup(elder, pickupElderId);
    if (!selfCheck.ok) throw new VerificationError(selfCheck.code, selfCheck.msg);
  } else if (pickupType === PICKUP_TYPES.PROXY) {
    const authCheck = checkProxyAuthorization(proxyAuthorization, at);
    if (!authCheck.ok) throw new VerificationError(authCheck.code, authCheck.msg);
    if (proxyAuthorization.elderId !== order.elderId) {
      throw new VerificationError(CONFLICT_TYPES.OWNER_MISMATCH, '代领授权归属与订餐长者不匹配（防冒领）');
    }
  } else {
    throw new VerificationError('INVALID_PICKUP_TYPE', '取餐方式无效');
  }

  const dupCheck = checkNoDuplicateServe(existingVerification);
  if (!dupCheck.ok) throw new VerificationError(dupCheck.code, dupCheck.msg);

  return { ok: true };
}

function resolveOfflineConflict(ctx) {
  const { order, offlineRecord, existingByToken, existingByElderMeal, at } = ctx;

  if (existingByToken) {
    return {
      resolution: RESOLUTIONS.REJECT,
      conflictType: CONFLICT_TYPES.DUPLICATE_TOKEN,
      note: `同一离线核销令牌 ${offlineRecord.offlineToken} 已补传过，幂等跳过`,
      existingVerification: existingByToken,
    };
  }

  if (!order) {
    return {
      resolution: RESOLUTIONS.REJECT,
      conflictType: CONFLICT_TYPES.NO_ORDER,
      note: '订餐不存在，离线核销作废',
    };
  }

  if (order.status === 'CANCELLED') {
    return {
      resolution: RESOLUTIONS.REJECT,
      conflictType: CONFLICT_TYPES.ORDER_CANCELLED,
      note: '该订餐线上已取消，离线核销作废',
    };
  }

  if (order.status === 'SERVED' && existingByElderMeal && existingByElderMeal.status === 'VALID') {
    const offlineTs = toTs(offlineRecord.verifiedAt);
    const existingTs = toTs(existingByElderMeal.verifiedAt);
    if (offlineTs >= existingTs) {
      return {
        resolution: RESOLUTIONS.REJECT,
        conflictType: CONFLICT_TYPES.ALREADY_SERVED,
        note: `线上已在 ${existingByElderMeal.verifiedAt} 核销，该离线记录（${offlineRecord.verifiedAt}）时间更晚，作废`,
        existingVerification: existingByElderMeal,
      };
    } else {
      return {
        resolution: RESOLUTIONS.SUPERSEDED,
        conflictType: CONFLICT_TYPES.ALREADY_SERVED,
        note: `离线记录时间（${offlineRecord.verifiedAt}）早于线上核销，以离线为准，原线上记录标记为 SUPERSEDED`,
        existingVerification: existingByElderMeal,
      };
    }
  }

  if (existingByElderMeal && existingByElderMeal.status === 'VALID') {
    const offlineTs = toTs(offlineRecord.verifiedAt);
    const existingTs = toTs(existingByElderMeal.verifiedAt);
    if (offlineTs >= existingTs) {
      return {
        resolution: RESOLUTIONS.REJECT,
        conflictType: CONFLICT_TYPES.ELDER_MEAL_DUPLICATE,
        note: `该长者此餐次已于 ${existingByElderMeal.verifiedAt} 核销，离线记录重复作废`,
        existingVerification: existingByElderMeal,
      };
    } else {
      return {
        resolution: RESOLUTIONS.SUPERSEDED,
        conflictType: CONFLICT_TYPES.ELDER_MEAL_DUPLICATE,
        note: `离线记录更早，覆盖已存在的核销记录`,
        existingVerification: existingByElderMeal,
      };
    }
  }

  if (order.status !== 'RESERVED') {
    return {
      resolution: RESOLUTIONS.REJECT,
      conflictType: CONFLICT_TYPES.ORDER_EXPIRED,
      note: `订餐状态 ${order.status} 不可核销，离线记录作废`,
    };
  }

  return { resolution: RESOLUTIONS.ACCEPT };
}

function buildVerificationRecord({ order, meal, pickupType, elder, proxyAuthorization,
  proxyIdCode, proxyName, verifierId, verifyChannel, offlineToken, verifiedAt, syncBatchId, syncedAt, status = 'VALID', conflictNote = null }) {
  return {
    orderId: order.id,
    elderId: order.elderId,
    mealId: order.mealId,
    canteenId: meal.canteenId,
    verifierId,
    pickupType,
    proxyAuthId: proxyAuthorization ? proxyAuthorization.id : null,
    proxyName: pickupType === PICKUP_TYPES.PROXY ? (proxyName || (proxyAuthorization ? proxyAuthorization.proxyName : null)) : null,
    proxyIdCode: pickupType === PICKUP_TYPES.PROXY ? (proxyIdCode || (proxyAuthorization ? proxyAuthorization.proxyIdCode : null)) : null,
    verifyChannel,
    offlineToken,
    verifiedAt,
    syncedAt,
    syncBatchId,
    status,
    conflictNote,
  };
}

function summarizeBatch(results) {
  const summary = { total: results.length, accepted: 0, rejected: 0, superseded: 0, details: [] };
  for (const r of results) {
    if (r.resolution === RESOLUTIONS.ACCEPTED || r.resolution === RESOLUTIONS.ACCEPT) summary.accepted += 1;
    else if (r.resolution === RESOLUTIONS.SUPERSEDED) { summary.accepted += 1; summary.superseded += 1; }
    else summary.rejected += 1;
    summary.details.push({
      offlineToken: r.offlineToken,
      orderId: r.orderId,
      resolution: r.resolution,
      conflictType: r.conflictType || null,
      note: r.note || null,
    });
  }
  return summary;
}

module.exports = {
  CONFLICT_TYPES,
  RESOLUTIONS,
  PICKUP_TYPES,
  VERIFY_CHANNELS,
  VerificationError,
  nowIso,
  toTs,
  checkOwnership,
  checkOrderStatusForVerify,
  checkNoDuplicateServe,
  checkSelfPickup,
  checkProxyAuthorization,
  validateOnlineVerify,
  resolveOfflineConflict,
  buildVerificationRecord,
  summarizeBatch,
};
