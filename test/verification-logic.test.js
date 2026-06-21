'use strict';

const test = require('node:test');
const assert = require('node:assert');

const v = require('../src/utils/verification');

test('checkOwnership: 长者身份匹配返回 true', () => {
  assert.strictEqual(v.checkOwnership({ elderId: 1 }, 1), true);
  assert.strictEqual(v.checkOwnership({ elderId: 1 }, 2), false);
  assert.strictEqual(v.checkOwnership(null, 1), false);
});

test('checkOrderStatusForVerify: RESERVED 可核销，其余不可', () => {
  assert.strictEqual(v.checkOrderStatusForVerify({ status: 'RESERVED' }).ok, true);
  assert.strictEqual(v.checkOrderStatusForVerify({ status: 'SERVED' }).ok, false);
  assert.strictEqual(v.checkOrderStatusForVerify({ status: 'CANCELLED' }).code, v.CONFLICT_TYPES.ORDER_CANCELLED);
  assert.strictEqual(v.checkOrderStatusForVerify(null).code, v.CONFLICT_TYPES.NO_ORDER);
});

test('checkNoDuplicateServe: VALID 核销记录存在视为重复', () => {
  assert.strictEqual(v.checkNoDuplicateServe(null).ok, true);
  assert.strictEqual(v.checkNoDuplicateServe({ status: 'VALID' }).ok, false);
  assert.strictEqual(v.checkNoDuplicateServe({ status: 'SUPERSEDED' }).ok, true);
});

test('checkProxyAuthorization: 有效期内 ACTIVE 授权有效', () => {
  const now = '2026-06-21T12:00:00.000Z';
  assert.strictEqual(v.checkProxyAuthorization({
    status: 'ACTIVE', validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-07-01T00:00:00.000Z',
  }, now).ok, true);
  assert.strictEqual(v.checkProxyAuthorization({
    status: 'REVOKED', validFrom: '2026-06-01', validUntil: '2026-07-01',
  }, now).ok, false);
  assert.strictEqual(v.checkProxyAuthorization({
    status: 'ACTIVE', validFrom: '2026-07-01', validUntil: '2026-08-01',
  }, now).code, 'AUTH_NOT_STARTED');
  assert.strictEqual(v.checkProxyAuthorization({
    status: 'ACTIVE', validFrom: '2026-05-01', validUntil: '2026-06-01',
  }, now).code, 'AUTH_EXPIRED');
  assert.strictEqual(v.checkProxyAuthorization(null, now).ok, false);
});

test('validateOnlineVerify: 本人取餐正常通过', () => {
  const order = { id: 1, elderId: 5, mealId: 10, status: 'RESERVED' };
  const elder = { id: 5, code: 'E-0001', name: '王秀英' };
  const at = '2026-06-21T12:00:00.000Z';
  assert.doesNotThrow(() => v.validateOnlineVerify({
    order, pickupElderId: 5, pickupType: v.PICKUP_TYPES.SELF,
    proxyAuthorization: null, at, existingVerification: null, elder,
  }));
});

test('validateOnlineVerify: 取餐人与订餐归属不匹配抛错防冒领', () => {
  const order = { id: 1, elderId: 5, mealId: 10, status: 'RESERVED' };
  const elder = { id: 6, code: 'E-0002', name: '李婆婆' };
  const at = '2026-06-21T12:00:00.000Z';
  assert.throws(() => v.validateOnlineVerify({
    order, pickupElderId: 6, pickupType: v.PICKUP_TYPES.SELF,
    proxyAuthorization: null, at, existingVerification: null, elder,
  }), v.VerificationError);
});

test('validateOnlineVerify: 已核销的重复领取被拦', () => {
  const order = { id: 1, elderId: 5, mealId: 10, status: 'RESERVED' };
  const elder = { id: 5, code: 'E-0001', name: '王秀英' };
  const at = '2026-06-21T12:00:00.000Z';
  assert.throws(() => v.validateOnlineVerify({
    order, pickupElderId: 5, pickupType: v.PICKUP_TYPES.SELF,
    proxyAuthorization: null, at, existingVerification: { status: 'VALID' }, elder,
  }), (err) => err.code === v.CONFLICT_TYPES.ALREADY_SERVED);
});

test('validateOnlineVerify: 无授权代领被拒', () => {
  const order = { id: 1, elderId: 5, mealId: 10, status: 'RESERVED' };
  const at = '2026-06-21T12:00:00.000Z';
  assert.throws(() => v.validateOnlineVerify({
    order, pickupElderId: null, pickupType: v.PICKUP_TYPES.PROXY,
    proxyAuthorization: null, at, existingVerification: null, elder: null,
  }), (err) => err.code === 'NO_AUTHORIZATION');
});

test('resolveOfflineConflict: 同 token 幂等跳过', () => {
  const r = v.resolveOfflineConflict({
    order: { id: 1, status: 'RESERVED' },
    offlineRecord: { offlineToken: 'tok-1', verifiedAt: '2026-06-21T12:00:00.000Z' },
    existingByToken: { id: 99, status: 'VALID' },
    existingByElderMeal: null, at: '2026-06-21T13:00:00.000Z',
  });
  assert.strictEqual(r.resolution, v.RESOLUTIONS.REJECT);
  assert.strictEqual(r.conflictType, v.CONFLICT_TYPES.DUPLICATE_TOKEN);
});

test('resolveOfflineConflict: 线上已取消的订单，离线核销作废', () => {
  const r = v.resolveOfflineConflict({
    order: { id: 1, status: 'CANCELLED' },
    offlineRecord: { offlineToken: 'tok-1', verifiedAt: '2026-06-21T12:00:00.000Z' },
    existingByToken: null, existingByElderMeal: null,
    at: '2026-06-21T13:00:00.000Z',
  });
  assert.strictEqual(r.resolution, v.RESOLUTIONS.REJECT);
  assert.strictEqual(r.conflictType, v.CONFLICT_TYPES.ORDER_CANCELLED);
});

test('resolveOfflineConflict: 线上已核销且更早，离线作废', () => {
  const r = v.resolveOfflineConflict({
    order: { id: 1, status: 'SERVED' },
    offlineRecord: { offlineToken: 'tok-1', verifiedAt: '2026-06-21T12:30:00.000Z' },
    existingByToken: null,
    existingByElderMeal: { id: 7, status: 'VALID', verifiedAt: '2026-06-21T12:00:00.000Z' },
    at: '2026-06-21T13:00:00.000Z',
  });
  assert.strictEqual(r.resolution, v.RESOLUTIONS.REJECT);
  assert.strictEqual(r.conflictType, v.CONFLICT_TYPES.ALREADY_SERVED);
});

test('resolveOfflineConflict: 离线更早，覆盖线上（SUPERSEDED）', () => {
  const r = v.resolveOfflineConflict({
    order: { id: 1, status: 'SERVED' },
    offlineRecord: { offlineToken: 'tok-1', verifiedAt: '2026-06-21T11:55:00.000Z' },
    existingByToken: null,
    existingByElderMeal: { id: 7, status: 'VALID', verifiedAt: '2026-06-21T12:00:00.000Z' },
    at: '2026-06-21T13:00:00.000Z',
  });
  assert.strictEqual(r.resolution, v.RESOLUTIONS.SUPERSEDED);
  assert.strictEqual(r.conflictType, v.CONFLICT_TYPES.ALREADY_SERVED);
});

test('resolveOfflineConflict: 正常 RESERVED 无冲突，ACCEPT', () => {
  const r = v.resolveOfflineConflict({
    order: { id: 1, status: 'RESERVED' },
    offlineRecord: { offlineToken: 'tok-1', verifiedAt: '2026-06-21T12:00:00.000Z' },
    existingByToken: null, existingByElderMeal: null,
    at: '2026-06-21T13:00:00.000Z',
  });
  assert.strictEqual(r.resolution, v.RESOLUTIONS.ACCEPT);
});

test('buildVerificationRecord: 本人领不存代领信息', () => {
  const rec = v.buildVerificationRecord({
    order: { id: 1, elderId: 5, mealId: 10 },
    meal: { id: 10, canteenId: 3 },
    pickupType: v.PICKUP_TYPES.SELF,
    verifierId: 2, verifyChannel: v.VERIFY_CHANNELS.ONLINE,
    verifiedAt: '2026-06-21T12:00:00.000Z',
  });
  assert.strictEqual(rec.pickupType, 'SELF');
  assert.strictEqual(rec.orderId, 1);
  assert.strictEqual(rec.canteenId, 3);
  assert.strictEqual(rec.proxyName, null);
  assert.strictEqual(rec.proxyIdCode, null);
});

test('buildVerificationRecord: 代领存完整代领信息', () => {
  const auth = { id: 7, proxyName: '张小明', proxyIdCode: 'ID-12345' };
  const rec = v.buildVerificationRecord({
    order: { id: 1, elderId: 5, mealId: 10 },
    meal: { id: 10, canteenId: 3 },
    pickupType: v.PICKUP_TYPES.PROXY, proxyAuthorization: auth,
    verifierId: 2, verifyChannel: v.VERIFY_CHANNELS.ONLINE,
    verifiedAt: '2026-06-21T12:00:00.000Z',
  });
  assert.strictEqual(rec.pickupType, 'PROXY');
  assert.strictEqual(rec.proxyAuthId, 7);
  assert.strictEqual(rec.proxyName, '张小明');
  assert.strictEqual(rec.proxyIdCode, 'ID-12345');
});

test('summarizeBatch: 统计接受、拒绝、覆盖', () => {
  const s = v.summarizeBatch([
    { resolution: v.RESOLUTIONS.ACCEPT, offlineToken: 'a', orderId: 1 },
    { resolution: v.RESOLUTIONS.SUPERSEDED, offlineToken: 'b', orderId: 2 },
    { resolution: v.RESOLUTIONS.REJECT, offlineToken: 'c', orderId: 3, conflictType: 'X' },
  ]);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.accepted, 2);
  assert.strictEqual(s.rejected, 1);
  assert.strictEqual(s.superseded, 1);
  assert.strictEqual(s.details.length, 3);
});
