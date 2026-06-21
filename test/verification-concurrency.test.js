'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');

const { getPool, ensureSchema, resetAll, waitForDb, close } = require('../src/db');
const { seed } = require('../src/seed');
const { createApp } = require('../src/app');

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

async function createReservedOrder(token, elderCode) {
  const elder = await findElderByCode(token, elderCode);
  const meals = (await request(app).get('/api/meals').set('Authorization', `Bearer ${token}`)).body.data;
  const meal = meals.find((m) => m.canteenId === elder.canteenId && m.status === 'PUBLISHED' && m.mealType === 'LUNCH');
  let orderId;
  const created = await request(app).post('/api/orders').set('Authorization', `Bearer ${token}`)
    .send({ elderId: elder.id, mealId: meal.id, diningType: 'DINE_IN', qty: 1 });
  if (created.status === 201) {
    orderId = created.body.data.id;
  } else if (created.status === 409) {
    const existing = (await request(app).get('/api/orders').set('Authorization', `Bearer ${token}`)
      .query({ elderId: elder.id, mealId: meal.id, status: 'RESERVED' })).body.data;
    assert.ok(existing.length >= 1, '已有预订但未找到 RESERVED');
    orderId = existing[0].id;
  } else {
    assert.fail(`无法创建订单: status=${created.status}, body=${JSON.stringify(created.body)}`);
  }
  return { orderId, elderCode, canteenId: meal.canteenId };
}

test('并发核销同一订单：仅一个成功，其余返回重复领取错误', async () => {
  const token = await loginAs('operator', 'operator123');
  const { orderId, elderCode, canteenId } = await createReservedOrder(token, 'E-0002');

  const N = 6;
  const responses = await Promise.all(
    Array.from({ length: N }, () =>
      request(app).post('/api/verifications/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ orderId, elderCode, pickupType: 'SELF', canteenId })
    )
  );

  const statuses = responses.map((r) => r.status);
  const ok = responses.filter((r) => r.status === 200);
  const rejected = responses.filter((r) => r.status === 409);

  assert.strictEqual(ok.length, 1,
    `应仅有 1 个核销成功，实际 ${ok.length}。响应状态: ${JSON.stringify(statuses)}`);
  assert.strictEqual(rejected.length, N - 1,
    `应有 ${N - 1} 个被拒绝，实际 ${rejected.length}。响应状态: ${JSON.stringify(statuses)}`);

  assert.ok(rejected.every((r) => r.status === 409 && r.body.error && (
    r.body.error.code === 'ALREADY_SERVED'
    || r.body.error.code === 'ORDER_EXPIRED'
    || r.body.error.message.includes('重复') || r.body.error.message.includes('已核销')
    || r.body.error.message.includes('不可核销')
  )), `被拒请求应为重复领取/状态不可核销错误，实际: ${JSON.stringify(rejected.map((r) => r.body))}`);

  const verifications = (await request(app).get('/api/verifications')
    .set('Authorization', `Bearer ${token}`).query({ orderId })).body.data;
  const valid = verifications.filter((v) => v.status === 'VALID');
  assert.strictEqual(valid.length, 1,
    `数据库应只有 1 条 VALID 核销记录，实际 ${valid.length}: ${JSON.stringify(verifications)}`);
});

test('并发核销同一长者同一餐次（同一订单）：仅一条 VALID 落库', async () => {
  const token = await loginAs('operator', 'operator123');
  const { orderId, elderCode, canteenId } = await createReservedOrder(token, 'E-0002');

  const N = 8;
  const responses = await Promise.all(
    Array.from({ length: N }, () =>
      request(app).post('/api/verifications/verify')
        .set('Authorization', `Bearer ${token}`)
        .send({ orderId, elderCode, pickupType: 'SELF', canteenId })
    )
  );

  const ok = responses.filter((r) => r.status === 200);
  assert.strictEqual(ok.length, 1, `应仅有 1 个成功，实际 ${ok.length}`);

  const valid = (await request(app).get('/api/verifications')
    .set('Authorization', `Bearer ${token}`).query({ orderId })).body.data
    .filter((v) => v.status === 'VALID');
  assert.strictEqual(valid.length, 1, `同长者同餐次仅一条 VALID，实际 ${valid.length}`);
});

test('在线核销与离线补传并发同订单：仅一条 VALID', async () => {
  const token = await loginAs('operator', 'operator123');
  const { orderId, canteenId } = await createReservedOrder(token, 'E-0002');

  const onlineReq = request(app).post('/api/verifications/verify')
    .set('Authorization', `Bearer ${token}`)
    .send({ orderId, elderCode: 'E-0002', pickupType: 'SELF', canteenId });

  const offlineReq = request(app).post('/api/verifications/offline-sync')
    .set('Authorization', `Bearer ${token}`)
    .send({
      canteenId, batchCode: 'BATCH-CONCURRENT-001',
      records: [{ orderId, offlineToken: 'TOK-CONCURRENT-001', verifiedAt: '2026-06-18T12:00:00.000Z', pickupType: 'SELF' }],
    });

  const [onlineRes, offlineRes] = await Promise.all([onlineReq, offlineReq]);

  const onlineOk = onlineRes.status === 200;
  const offlineAccepted = offlineRes.status === 200 && offlineRes.body.data.results[0].resolution === 'ACCEPT';
  const offlineRejected = offlineRes.status === 200 && offlineRes.body.data.results[0].resolution !== 'ACCEPT';

  assert.ok(onlineOk || offlineAccepted,
    `至少应有一个成功。在线=${onlineRes.status}, 离线=${JSON.stringify(offlineRes.body)}`);
  assert.ok(!(onlineOk && offlineAccepted),
    `在线与离线不应同时成功。在线=${onlineRes.status}, 离线结果=${JSON.stringify(offlineRes.body.data?.results)}`);

  if (offlineRejected) {
    assert.ok(['DUPLICATE_TOKEN', 'ALREADY_SERVED'].includes(offlineRes.body.data.results[0].conflictType),
      `离线应因并发被拒，实际: ${JSON.stringify(offlineRes.body.data.results[0])}`);
  }

  const valid = (await request(app).get('/api/verifications')
    .set('Authorization', `Bearer ${token}`).query({ orderId })).body.data
    .filter((v) => v.status === 'VALID');
  assert.strictEqual(valid.length, 1,
    `在线+离线并发后仅一条 VALID，实际 ${valid.length}`);
});
