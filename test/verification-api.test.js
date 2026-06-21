'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');
const store = require('../src/data/store');

const app = createApp();

test.before(async () => { await waitForDb(); await ensureSchema(); getPool(); });
test.beforeEach(async () => { await resetAll(); await seed(); });
test.after(async () => { await close(); });

async function loginAs(u, p) {
  const res = await request(app).post('/api/auth/login').send({ username: u, password: p });
  assert.strictEqual(res.status, 200, `登录失败: ${JSON.stringify(res.body)}`);
  return res.body.data.token;
}

async function findElderByCode(token, code) {
  const list = await request(app).get('/api/elders').set('Authorization', `Bearer ${token}`);
  return list.body.data.find((e) => e.code === code);
}

async function findPublishedMeal(token, opts = {}) {
  const list = await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`).query(opts);
  return list.body.data.find((m) => m.status === 'PUBLISHED');
}

test('在线核销：助餐点归属不匹配被拒绝', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0001');
  const meal = await findPublishedMeal(token);
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201);

  const wrongCanteenId = meal.canteenId === 1 ? 2 : 1;
  const verify = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId: order.body.data.id, elderCode: elder.code, pickupType: 'SELF', canteenId: wrongCanteenId });
  assert.strictEqual(verify.status, 409, JSON.stringify(verify.body));
  assert.ok(verify.body.error.code === 'CANTEEN_MISMATCH' || verify.body.error.message.includes('助餐点'),
    `期望助餐点不匹配错误，实际: ${JSON.stringify(verify.body)}`);
});

test('在线核销：本人取餐身份不匹配防冒领', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder1 = await findElderByCode(token, 'E-0001');
  const elder2 = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const mealForElder2 = meals.find((m) => m.canteenId === elder2.canteenId && m.mealType === 'DINNER');
  let orderId;
  try {
    const created = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
      .send({ elderId: elder2.id, mealId: mealForElder2.id, diningType: 'DINE_IN', qty: 1 });
    if (created.status === 201) {
      orderId = created.body.data.id;
    } else if (created.status === 409) {
      const existing = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
        .query({ elderId: elder2.id, mealId: mealForElder2.id, status: 'RESERVED' })).body.data;
      assert.ok(existing.length >= 1, '种子/已有预订但没找到 RESERVED');
      orderId = existing[0].id;
    } else {
      assert.fail(`无法获得订单: status=${created.status}, body=${JSON.stringify(created.body)}`);
    }
  } catch (e) {
    assert.fail(e.message);
  }

  const verify = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, elderCode: elder1.code, pickupType: 'SELF', canteenId: mealForElder2.canteenId });
  assert.strictEqual(verify.status, 409);
  assert.ok(verify.body.error.code === 'OWNER_MISMATCH' || verify.body.error.message.includes('冒领'),
    `期望 OWNER_MISMATCH，实际: ${JSON.stringify(verify.body)}`);
});

test('在线核销：代领无授权被拒', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0001');
  const meal = await findPublishedMeal(token, { canteenId: elder.canteenId });
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201);

  const verify = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId: order.body.data.id, pickupType: 'PROXY', proxyIdCode: 'STRANGER-001', canteenId: meal.canteenId });
  assert.strictEqual(verify.status, 409);
  assert.ok(verify.body.error.code === 'NO_AUTHORIZATION' || verify.body.error.code === 'AUTH_REVOKED'
    || verify.body.error.message.includes('授权'), JSON.stringify(verify.body));
});

test('在线核销：代领有授权成功通过', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0001');
  const meal = await findPublishedMeal(token, { canteenId: elder.canteenId });
  const order = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  assert.strictEqual(order.status, 201);

  const auth = await request(app).post('/api/authorizations').set('Authorization', `Bearer ${token}`)
    .send({
      elderId: elder.id, proxyName: '张小明', proxyPhone: '13900000001', proxyIdCode: 'CHILD-0001',
      validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-07-01T00:00:00.000Z',
    });
  assert.strictEqual(auth.status, 201);

  const verify = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId: order.body.data.id, pickupType: 'PROXY', proxyIdCode: 'CHILD-0001', canteenId: meal.canteenId });
  assert.strictEqual(verify.status, 200, JSON.stringify(verify.body));
  assert.strictEqual(verify.body.data.order.status, 'SERVED');
  assert.strictEqual(verify.body.data.verification.pickupType, 'PROXY');
  assert.strictEqual(verify.body.data.verification.proxyIdCode, 'CHILD-0001');
  assert.strictEqual(verify.body.data.verification.proxyAuthId, auth.body.data.id);
});

test('在线核销：同一长者同餐次重复领取被拦', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const reserved = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id, status: 'RESERVED' })).body.data;
  assert.ok(reserved.length >= 1, '种子数据里应有 E-0002 对晚餐的预订');
  const orderId = reserved[0].id;

  const v1 = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, elderCode: elder.code, pickupType: 'SELF', canteenId: meal.canteenId });
  assert.strictEqual(v1.status, 200, JSON.stringify(v1.body));

  const v2 = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, elderCode: elder.code, pickupType: 'SELF', canteenId: meal.canteenId });
  assert.strictEqual(v2.status, 409);
});

test('离线补传：缺少 offlineToken 被整体拒绝', async () => {
  const token = await loginAs('operator', 'operator123');
  const res = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`)
    .send({
      canteenId: 1, batchCode: 'BAD-BATCH-001',
      records: [{ orderId: 9999, verifiedAt: '2026-06-18T12:00:00.000Z' }],
    });
  assert.strictEqual(res.status, 400);
  assert.ok(Array.isArray(res.body.error.errors) && res.body.error.errors.length > 0);
});

test('离线补传：同批次号幂等', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const orders = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id })).body.data;
  const order = orders[0];

  const body = {
    canteenId: meal.canteenId,
    batchCode: 'BATCH-IDEMPOTENT-001',
    records: [{
      orderId: order.id, offlineToken: 'TOK-IDEM-001',
      verifiedAt: '2026-06-18T12:05:00.000Z', pickupType: 'SELF',
    }],
  };
  const r1 = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send(body);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  assert.strictEqual(r1.body.data.results[0].resolution, 'ACCEPT');

  const r2 = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send(body);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.data.note, '该批次已处理过，幂等返回');
  assert.strictEqual(r2.body.data.batch.batchCode, 'BATCH-IDEMPOTENT-001');
});

test('离线补传：逐笔幂等（同一 token 出现在两批次都只生效一次）', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const orders = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id })).body.data;
  const order = orders[0];

  const r1 = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send({
      canteenId: meal.canteenId, batchCode: 'BATCH-A',
      records: [{ orderId: order.id, offlineToken: 'TOK-DUP-001', verifiedAt: '2026-06-18T12:10:00.000Z', pickupType: 'SELF' }],
    });
  assert.strictEqual(r1.body.data.results[0].resolution, 'ACCEPT');

  const r2 = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send({
      canteenId: meal.canteenId, batchCode: 'BATCH-B',
      records: [{ orderId: order.id, offlineToken: 'TOK-DUP-001', verifiedAt: '2026-06-18T12:10:00.000Z', pickupType: 'SELF' }],
    });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.data.results[0].resolution, 'REJECT');
  assert.strictEqual(r2.body.data.results[0].conflictType, 'DUPLICATE_TOKEN');
});

test('离线补传：多种冲突类型全部落库可查', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const orders = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id, status: 'RESERVED' })).body.data;
  const reservedOrderId = orders[0].id;

  await request(app).post(`/api/orders/${reservedOrderId}/cancel`).set('Authorization', `Bearer ${token}`);

  const batch = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send({
      canteenId: meal.canteenId, batchCode: 'BATCH-CONFLICTS',
      records: [
        { orderId: reservedOrderId, offlineToken: 'TOK-CANCELLED', verifiedAt: '2026-06-18T12:00:00.000Z', pickupType: 'SELF' },
        { orderId: 999999, offlineToken: 'TOK-NO-ORDER', verifiedAt: '2026-06-18T12:00:00.000Z', pickupType: 'SELF' },
      ],
    });
  assert.strictEqual(batch.status, 200, JSON.stringify(batch.body));
  const batchId = batch.body.data.batch.id;

  const conflicts = (await request(app).get('/api/verifications/conflicts')
    .set('Authorization', `Bearer ${token}`).query({ syncBatchId: batchId })).body.data;
  assert.strictEqual(conflicts.length, 2, `期望 2 条冲突，实际 ${conflicts.length}: ${JSON.stringify(conflicts)}`);
  const types = conflicts.map((c) => c.conflictType).sort();
  assert.deepStrictEqual(types, ['NO_ORDER', 'ORDER_CANCELLED']);
  assert.ok(conflicts.every((c) => c.syncBatchId === batchId));
  assert.ok(conflicts.every((c) => c.resolution === 'REJECT'));
  const noOrderConflict = conflicts.find((c) => c.conflictType === 'NO_ORDER');
  assert.strictEqual(noOrderConflict.orderId, null, 'NO_ORDER 应 orderId 为 NULL');
  assert.strictEqual(noOrderConflict.unknownOrderId, '999999', 'NO_ORDER 原始值存 unknownOrderId');
});

test('离线补传：代领必须有有效授权，否则拒绝并落库', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const orders = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id, status: 'RESERVED' })).body.data;
  const orderId = orders[0].id;

  const batch = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send({
      canteenId: meal.canteenId, batchCode: 'BATCH-PROXY-NOAUTH',
      records: [{
        orderId, offlineToken: 'TOK-PROXY-NOAUTH',
        verifiedAt: '2026-06-18T12:00:00.000Z',
        pickupType: 'PROXY', proxyIdCode: 'UNAUTHORIZED-PROXY', proxyName: '陌生代领人',
      }],
    });
  assert.strictEqual(batch.status, 200, JSON.stringify(batch.body));
  assert.strictEqual(batch.body.data.results[0].resolution, 'REJECT');
  assert.strictEqual(batch.body.data.results[0].conflictType, 'OFFLINE_PROXY_NO_AUTH');

  const conflicts = (await request(app).get('/api/verifications/conflicts')
    .set('Authorization', `Bearer ${token}`).query({ syncBatchId: batch.body.data.batch.id })).body.data;
  assert.ok(conflicts.some((c) => c.conflictType === 'OFFLINE_PROXY_NO_AUTH'));
});

test('离线补传：代领有授权则成功核销并留痕', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const orders = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id, status: 'RESERVED' })).body.data;
  const orderId = orders[0].id;

  const auth = await request(app).post('/api/authorizations').set('Authorization', `Bearer ${token}`)
    .send({
      elderId: elder.id, proxyName: '赵晓军', proxyPhone: '13900000002', proxyIdCode: 'ZHAO-SON-001',
      validFrom: '2026-06-01T00:00:00.000Z', validUntil: '2026-07-01T00:00:00.000Z',
    });
  assert.strictEqual(auth.status, 201);

  const batch = await request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`).send({
      canteenId: meal.canteenId, batchCode: 'BATCH-PROXY-AUTH',
      records: [{
        orderId, offlineToken: 'TOK-PROXY-AUTH-OK',
        verifiedAt: '2026-06-18T12:00:00.000Z',
        pickupType: 'PROXY', proxyIdCode: 'ZHAO-SON-001', proxyName: '赵晓军',
      }],
    });
  assert.strictEqual(batch.status, 200, JSON.stringify(batch.body));
  assert.strictEqual(batch.body.data.results[0].resolution, 'ACCEPT');

  const verifications = (await request(app).get('/api/verifications')
    .set('Authorization', `Bearer ${token}`).query({ orderId })).body.data;
  const ok = verifications.find((v) => v.status === 'VALID');
  assert.ok(ok, '应存在 VALID 核销记录');
  assert.strictEqual(ok.pickupType, 'PROXY');
  assert.strictEqual(ok.proxyIdCode, 'ZHAO-SON-001');
  assert.strictEqual(ok.proxyAuthId, auth.body.data.id);
  assert.strictEqual(ok.verifyChannel, 'OFFLINE');
});

test('路由顺序正确：/batches 和 /conflicts 静态路由不被 /:id 拦截', async () => {
  const token = await loginAs('operator', 'operator123');
  const batches = await request(app).get('/api/verifications/batches').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(batches.status, 200, `路由被拦截: ${JSON.stringify(batches.body)}`);
  assert.ok(Array.isArray(batches.body.data));

  const conflicts = await request(app).get('/api/verifications/conflicts').set('Authorization', `Bearer ${token}`);
  assert.strictEqual(conflicts.status, 200);
  assert.ok(Array.isArray(conflicts.body.data));
});

test('旧 /orders/:id/serve 接口虽兼容，但 /verify 必须真实刷卡/扫码', async () => {
  const token = await loginAs('operator', 'operator123');
  const elder = await findElderByCode(token, 'E-0002');
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.mealType === 'DINNER');
  const orders = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
    .query({ elderId: elder.id, mealId: meal.id, status: 'RESERVED' })).body.data;
  const orderId = orders[0].id;

  const noElderCode = await request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, pickupType: 'SELF', canteenId: meal.canteenId });
  assert.strictEqual(noElderCode.status, 400);
  assert.ok(noElderCode.body.error.message.includes('长者编号') || noElderCode.body.error.message.includes('刷卡'));

  const compatibleServe = await request(app).post(`/api/orders/${orderId}/serve`)
    .set('Authorization', `Bearer ${token}`);
  assert.strictEqual(compatibleServe.status, 200, '旧 /serve 仍应兼容成功');
  assert.strictEqual(compatibleServe.body.data.status, 'SERVED');
});
