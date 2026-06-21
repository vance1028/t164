'use strict';

const { getPool } = require('../db');
const { hashPassword } = require('../utils/password');

function toMysqlDateTime(v) {
  if (!v) return v;
  if (v instanceof Date) {
    const pad = (n) => String(n).padStart(2, '0');
    const ms = String(v.getMilliseconds()).padStart(3, '0');
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}.${ms}`;
  }
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(v)) return v;
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return toMysqlDateTime(d);
  }
  return v;
}

function exec(conn, sql, params) {
  return (conn || getPool()).query(sql, params);
}

/* ----------------------------- 映射 ----------------------------- */
function mapUser(r) {
  if (!r) return null;
  return { id: r.id, username: r.username, name: r.name, role: r.role, status: r.status, createdAt: r.created_at };
}
function mapUserWithHash(r) { return r ? { ...mapUser(r), passwordHash: r.password_hash } : null; }
function mapCanteen(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, district: r.district, address: r.address, capacity: r.capacity, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapElder(r) {
  if (!r) return null;
  return { id: r.id, code: r.code, name: r.name, gender: r.gender, age: r.age, phone: r.phone, subsidyLevel: r.subsidy_level, dietary: r.dietary, canteenId: r.canteen_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapMeal(r) {
  if (!r) return null;
  return { id: r.id, canteenId: r.canteen_id, serveDate: r.serve_date, mealType: r.meal_type, dishName: r.dish_name, priceCents: r.price_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapOrder(r) {
  if (!r) return null;
  return { id: r.id, elderId: r.elder_id, mealId: r.meal_id, diningType: r.dining_type, qty: r.qty, amountCents: r.amount_cents, subsidyCents: r.subsidy_cents, payCents: r.pay_cents, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
}
function mapAuthorization(r) {
  if (!r) return null;
  return {
    id: r.id, elderId: r.elder_id, authorizedBy: r.authorized_by,
    proxyName: r.proxy_name, proxyPhone: r.proxy_phone, proxyIdCode: r.proxy_id_code,
    validFrom: r.valid_from, validUntil: r.valid_until,
    status: r.status, revokedAt: r.revoked_at, revokedBy: r.revoked_by,
    note: r.note, createdAt: r.created_at, updatedAt: r.updated_at
  };
}
function mapVerification(r) {
  if (!r) return null;
  return {
    id: r.id, orderId: r.order_id, elderId: r.elder_id, mealId: r.meal_id,
    canteenId: r.canteen_id, verifierId: r.verifier_id,
    pickupType: r.pickup_type, proxyAuthId: r.proxy_auth_id,
    proxyName: r.proxy_name, proxyIdCode: r.proxy_id_code,
    verifyChannel: r.verify_channel, offlineToken: r.offline_token,
    verifiedAt: r.verified_at, syncedAt: r.synced_at, syncBatchId: r.sync_batch_id,
    status: r.status, conflictNote: r.conflict_note, createdAt: r.created_at
  };
}
function mapSyncBatch(r) {
  if (!r) return null;
  return {
    id: r.id, canteenId: r.canteen_id, operatorId: r.operator_id,
    batchCode: r.batch_code, recordCount: r.record_count,
    processedAt: r.processed_at, status: r.status,
    summary: r.summary, createdAt: r.created_at
  };
}
function mapConflict(r) {
  if (!r) return null;
  return {
    id: r.id, syncBatchId: r.sync_batch_id, orderId: r.order_id, unknownOrderId: r.unknown_order_id,
    offlineToken: r.offline_token, offlineVerifiedAt: r.offline_verified_at,
    existingStatus: r.existing_status, existingVerifiedAt: r.existing_verified_at,
    conflictType: r.conflict_type, resolution: r.resolution,
    note: r.note, createdAt: r.created_at
  };
}

/* ----------------------------- 用户 ----------------------------- */
async function getUserByUsername(u, conn) { const [r] = await exec(conn, 'SELECT * FROM users WHERE username=?', [u]); return mapUserWithHash(r[0]); }
async function getUserById(id, conn) { const [r] = await exec(conn, 'SELECT * FROM users WHERE id=?', [id]); return mapUser(r[0]); }
async function listUsers(conn) { const [r] = await exec(conn, 'SELECT * FROM users ORDER BY id'); return r.map(mapUser); }
async function createUser({ username, password, name, role = 'VIEWER', status = 'ACTIVE' }, conn) {
  const [x] = await exec(conn, 'INSERT INTO users (username,password_hash,name,role,status) VALUES (?,?,?,?,?)', [username, hashPassword(password), name, role, status]);
  return getUserById(x.insertId, conn);
}
async function updateUser(id, f, conn) {
  const sets = []; const p = [];
  for (const [k, col] of Object.entries({ name: 'name', role: 'role', status: 'status' })) if (f[k] !== undefined) { sets.push(`${col}=?`); p.push(f[k]); }
  if (f.password !== undefined) { sets.push('password_hash=?'); p.push(hashPassword(f.password)); }
  if (sets.length) { p.push(id); await exec(conn, `UPDATE users SET ${sets.join(',')} WHERE id=?`, p); }
  return getUserById(id, conn);
}
async function deleteUser(id, conn) { const [x] = await exec(conn, 'DELETE FROM users WHERE id=?', [id]); return x.affectedRows > 0; }
async function countUsers(conn) { const [r] = await exec(conn, 'SELECT COUNT(*) AS n FROM users'); return r[0].n; }

/* ----------------------------- 助餐点 ----------------------------- */
async function listCanteens({ district, status, keyword } = {}, conn) {
  const w = []; const p = [];
  if (district) { w.push('district=?'); p.push(district); }
  if (status) { w.push('status=?'); p.push(status); }
  if (keyword) { w.push('(code LIKE ? OR name LIKE ?)'); const k = `%${keyword}%`; p.push(k, k); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM canteens ${c} ORDER BY id DESC`, p); return r.map(mapCanteen);
}
async function getCanteenById(id, conn) { const [r] = await exec(conn, 'SELECT * FROM canteens WHERE id=?', [id]); return mapCanteen(r[0]); }
async function getCanteenByCode(code, conn) { const [r] = await exec(conn, 'SELECT * FROM canteens WHERE code=?', [code]); return mapCanteen(r[0]); }
async function createCanteen(d, conn) {
  const [x] = await exec(conn, 'INSERT INTO canteens (code,name,district,address,capacity,status) VALUES (?,?,?,?,?,?)', [d.code, d.name, d.district, d.address || '', d.capacity || 0, d.status || 'OPEN']);
  return getCanteenById(x.insertId, conn);
}
async function updateCanteen(id, d, conn) {
  const sets = []; const p = [];
  for (const [k, col] of Object.entries({ name: 'name', district: 'district', address: 'address', capacity: 'capacity', status: 'status' })) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await exec(conn, `UPDATE canteens SET ${sets.join(',')} WHERE id=?`, p); }
  return getCanteenById(id, conn);
}
async function deleteCanteen(id, conn) { const [x] = await exec(conn, 'DELETE FROM canteens WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 长者 ----------------------------- */
async function listElders({ canteenId, subsidyLevel, status, keyword } = {}, conn) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (subsidyLevel) { w.push('subsidy_level=?'); p.push(subsidyLevel); }
  if (status) { w.push('status=?'); p.push(status); }
  if (keyword) { w.push('(code LIKE ? OR name LIKE ? OR phone LIKE ?)'); const k = `%${keyword}%`; p.push(k, k, k); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM elders ${c} ORDER BY id DESC`, p); return r.map(mapElder);
}
async function getElderById(id, conn) { const [r] = await exec(conn, 'SELECT * FROM elders WHERE id=?', [id]); return mapElder(r[0]); }
async function getElderByCode(code, conn) { const [r] = await exec(conn, 'SELECT * FROM elders WHERE code=?', [code]); return mapElder(r[0]); }
async function createElder(d, conn) {
  const [x] = await exec(conn, 'INSERT INTO elders (code,name,gender,age,phone,subsidy_level,dietary,canteen_id,status) VALUES (?,?,?,?,?,?,?,?,?)',
    [d.code, d.name, d.gender || 'U', d.age || 0, d.phone || '', d.subsidyLevel || 'C', d.dietary || '', d.canteenId ?? null, d.status || 'ACTIVE']);
  return getElderById(x.insertId, conn);
}
async function updateElder(id, d, conn) {
  const map = { name: 'name', gender: 'gender', age: 'age', phone: 'phone', subsidyLevel: 'subsidy_level', dietary: 'dietary', canteenId: 'canteen_id', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await exec(conn, `UPDATE elders SET ${sets.join(',')} WHERE id=?`, p); }
  return getElderById(id, conn);
}
async function deleteElder(id, conn) { const [x] = await exec(conn, 'DELETE FROM elders WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 餐次 ----------------------------- */
async function listMeals({ canteenId, serveDate, mealType, status } = {}, conn) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (serveDate) { w.push('serve_date=?'); p.push(serveDate); }
  if (mealType) { w.push('meal_type=?'); p.push(mealType); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM meals ${c} ORDER BY serve_date DESC, id DESC`, p); return r.map(mapMeal);
}
async function getMealById(id, conn) { const [r] = await exec(conn, 'SELECT * FROM meals WHERE id=?', [id]); return mapMeal(r[0]); }
async function createMeal(d, conn) {
  const [x] = await exec(conn, 'INSERT INTO meals (canteen_id,serve_date,meal_type,dish_name,price_cents,status) VALUES (?,?,?,?,?,?)',
    [d.canteenId, d.serveDate, d.mealType || 'LUNCH', d.dishName, d.priceCents || 0, d.status || 'PUBLISHED']);
  return getMealById(x.insertId, conn);
}
async function updateMeal(id, d, conn) {
  const map = { serveDate: 'serve_date', mealType: 'meal_type', dishName: 'dish_name', priceCents: 'price_cents', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await exec(conn, `UPDATE meals SET ${sets.join(',')} WHERE id=?`, p); }
  return getMealById(id, conn);
}
async function deleteMeal(id, conn) { const [x] = await exec(conn, 'DELETE FROM meals WHERE id=?', [id]); return x.affectedRows > 0; }

/* ----------------------------- 订餐 ----------------------------- */
async function listOrders({ elderId, mealId, status } = {}, conn) {
  const w = []; const p = [];
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (mealId !== undefined) { w.push('meal_id=?'); p.push(mealId); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM orders ${c} ORDER BY id DESC`, p); return r.map(mapOrder);
}
async function getOrderById(id, conn) { const [r] = await exec(conn, 'SELECT * FROM orders WHERE id=?', [id]); return mapOrder(r[0]); }
async function getOrderByElderAndMeal(elderId, mealId, conn) {
  const [r] = await exec(conn, 'SELECT * FROM orders WHERE elder_id=? AND meal_id=?', [elderId, mealId]);
  return mapOrder(r[0]);
}
async function createOrder(d, conn) {
  const [x] = await exec(conn, 'INSERT INTO orders (elder_id,meal_id,dining_type,qty,amount_cents,subsidy_cents,pay_cents,status) VALUES (?,?,?,?,?,?,?,?)',
    [d.elderId, d.mealId, d.diningType || 'DINE_IN', d.qty || 1, d.amountCents || 0, d.subsidyCents || 0, d.payCents || 0, d.status || 'RESERVED']);
  return getOrderById(x.insertId, conn);
}
async function updateOrder(id, d, conn) {
  const map = { diningType: 'dining_type', qty: 'qty', amountCents: 'amount_cents', subsidyCents: 'subsidy_cents', payCents: 'pay_cents', status: 'status' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await exec(conn, `UPDATE orders SET ${sets.join(',')} WHERE id=?`, p); }
  return getOrderById(id, conn);
}

/* ----------------------------- 代领授权 ----------------------------- */
async function listAuthorizations({ elderId, proxyIdCode, status } = {}, conn) {
  const w = []; const p = [];
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (proxyIdCode) { w.push('proxy_id_code=?'); p.push(proxyIdCode); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM pickup_authorizations ${c} ORDER BY id DESC`, p);
  return r.map(mapAuthorization);
}
async function getAuthorizationById(id, conn) {
  const [r] = await exec(conn, 'SELECT * FROM pickup_authorizations WHERE id=?', [id]);
  return mapAuthorization(r[0]);
}
async function findActiveAuthorization(elderId, proxyIdCode, at, conn) {
  const atMysql = toMysqlDateTime(at);
  const [r] = await exec(conn,
    `SELECT * FROM pickup_authorizations
     WHERE elder_id=? AND proxy_id_code=? AND status='ACTIVE'
       AND valid_from<=? AND valid_until>=?`,
    [elderId, proxyIdCode, atMysql, atMysql]
  );
  return mapAuthorization(r[0]);
}
async function createAuthorization(d, conn) {
  const [x] = await exec(conn,
    `INSERT INTO pickup_authorizations (elder_id,authorized_by,proxy_name,proxy_phone,proxy_id_code,valid_from,valid_until,status,note)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [d.elderId, d.authorizedBy, d.proxyName, d.proxyPhone || '', d.proxyIdCode,
     toMysqlDateTime(d.validFrom), toMysqlDateTime(d.validUntil), d.status || 'ACTIVE', d.note || '']
  );
  return getAuthorizationById(x.insertId, conn);
}
async function revokeAuthorization(id, revokedBy, revokedAt, conn) {
  await exec(conn,
    `UPDATE pickup_authorizations SET status='REVOKED', revoked_at=?, revoked_by=?, updated_at=CURRENT_TIMESTAMP(3) WHERE id=?`,
    [toMysqlDateTime(revokedAt), revokedBy, id]
  );
  return getAuthorizationById(id, conn);
}
async function updateAuthorization(id, d, conn) {
  const map = { validFrom: 'valid_from', validUntil: 'valid_until', note: 'note', proxyName: 'proxy_name', proxyPhone: 'proxy_phone' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) {
    if (d[k] !== undefined) {
      sets.push(`${col}=?`);
      p.push((k === 'validFrom' || k === 'validUntil') ? toMysqlDateTime(d[k]) : d[k]);
    }
  }
  if (sets.length) { sets.push('updated_at=CURRENT_TIMESTAMP(3)'); p.push(id); await exec(conn, `UPDATE pickup_authorizations SET ${sets.join(',')} WHERE id=?`, p); }
  return getAuthorizationById(id, conn);
}

/* ----------------------------- 核销记录 ----------------------------- */
async function listVerifications({ orderId, elderId, mealId, canteenId, status, offlineToken } = {}, conn) {
  const w = []; const p = [];
  if (orderId !== undefined) { w.push('order_id=?'); p.push(orderId); }
  if (elderId !== undefined) { w.push('elder_id=?'); p.push(elderId); }
  if (mealId !== undefined) { w.push('meal_id=?'); p.push(mealId); }
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (status) { w.push('status=?'); p.push(status); }
  if (offlineToken) { w.push('offline_token=?'); p.push(offlineToken); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM verification_records ${c} ORDER BY verified_at DESC, id DESC`, p);
  return r.map(mapVerification);
}
async function getVerificationById(id, conn) {
  const [r] = await exec(conn, 'SELECT * FROM verification_records WHERE id=?', [id]);
  return mapVerification(r[0]);
}
async function getVerificationByOfflineToken(token, conn) {
  const [r] = await exec(conn, 'SELECT * FROM verification_records WHERE offline_token=?', [token]);
  return mapVerification(r[0]);
}
async function getValidVerificationByElderAndMeal(elderId, mealId, conn) {
  const [r] = await exec(conn,
    `SELECT * FROM verification_records WHERE elder_id=? AND meal_id=? AND status='VALID' ORDER BY id DESC LIMIT 1`,
    [elderId, mealId]
  );
  return mapVerification(r[0]);
}
async function createVerification(d, conn) {
  const [x] = await exec(conn,
    `INSERT INTO verification_records
     (order_id,elder_id,meal_id,canteen_id,verifier_id,pickup_type,proxy_auth_id,proxy_name,proxy_id_code,verify_channel,offline_token,verified_at,synced_at,sync_batch_id,status,conflict_note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [d.orderId, d.elderId, d.mealId, d.canteenId, d.verifierId ?? null, d.pickupType || 'SELF',
     d.proxyAuthId ?? null, d.proxyName ?? null, d.proxyIdCode ?? null,
     d.verifyChannel || 'ONLINE', d.offlineToken ?? null, toMysqlDateTime(d.verifiedAt),
     d.syncedAt ? toMysqlDateTime(d.syncedAt) : null, d.syncBatchId ?? null, d.status || 'VALID', d.conflictNote ?? null]
  );
  return getVerificationById(x.insertId, conn);
}
async function updateVerificationStatus(id, status, conflictNote, conn) {
  await exec(conn,
    `UPDATE verification_records SET status=?, conflict_note=? WHERE id=?`,
    [status, conflictNote ?? null, id]
  );
  return getVerificationById(id, conn);
}

/* ----------------------------- 离线补传批次 ----------------------------- */
async function listSyncBatches({ canteenId, status } = {}, conn) {
  const w = []; const p = [];
  if (canteenId !== undefined) { w.push('canteen_id=?'); p.push(canteenId); }
  if (status) { w.push('status=?'); p.push(status); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM offline_sync_batches ${c} ORDER BY id DESC`, p);
  return r.map(mapSyncBatch);
}
async function getSyncBatchById(id, conn) {
  const [r] = await exec(conn, 'SELECT * FROM offline_sync_batches WHERE id=?', [id]);
  return mapSyncBatch(r[0]);
}
async function getSyncBatchByCode(code, conn) {
  const [r] = await exec(conn, 'SELECT * FROM offline_sync_batches WHERE batch_code=?', [code]);
  return mapSyncBatch(r[0]);
}
async function createSyncBatch(d, conn) {
  const [x] = await exec(conn,
    `INSERT INTO offline_sync_batches (canteen_id,operator_id,batch_code,record_count,status,summary)
     VALUES (?,?,?,?,?,?)`,
    [d.canteenId, d.operatorId, d.batchCode, d.recordCount || 0, d.status || 'PENDING', d.summary ?? null]
  );
  return getSyncBatchById(x.insertId, conn);
}
async function updateSyncBatch(id, d, conn) {
  const map = { recordCount: 'record_count', status: 'status', summary: 'summary' };
  const sets = []; const p = [];
  for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col}=?`); p.push(d[k]); }
  if (d.processedAt !== undefined) { sets.push('processed_at=?'); p.push(toMysqlDateTime(d.processedAt)); }
  if (sets.length) { p.push(id); await exec(conn, `UPDATE offline_sync_batches SET ${sets.join(',')} WHERE id=?`, p); }
  return getSyncBatchById(id, conn);
}

/* ----------------------------- 冲突裁决记录 ----------------------------- */
async function listConflicts({ orderId, syncBatchId, conflictType } = {}, conn) {
  const w = []; const p = [];
  if (orderId !== undefined) { w.push('order_id=?'); p.push(orderId); }
  if (syncBatchId !== undefined) { w.push('sync_batch_id=?'); p.push(syncBatchId); }
  if (conflictType) { w.push('conflict_type=?'); p.push(conflictType); }
  const c = w.length ? `WHERE ${w.join(' AND ')}` : '';
  const [r] = await exec(conn, `SELECT * FROM verification_conflicts ${c} ORDER BY id DESC`, p);
  return r.map(mapConflict);
}
async function getConflictById(id, conn) {
  const [r] = await exec(conn, 'SELECT * FROM verification_conflicts WHERE id=?', [id]);
  return mapConflict(r[0]);
}
async function createConflict(d, conn) {
  const [x] = await exec(conn,
    `INSERT INTO verification_conflicts
     (sync_batch_id,order_id,unknown_order_id,offline_token,offline_verified_at,existing_status,existing_verified_at,conflict_type,resolution,note)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [d.syncBatchId ?? null, d.orderId ?? null, d.unknownOrderId ?? null, d.offlineToken ?? null, toMysqlDateTime(d.offlineVerifiedAt),
     d.existingStatus, d.existingVerifiedAt ? toMysqlDateTime(d.existingVerifiedAt) : null, d.conflictType, d.resolution, d.note ?? null]
  );
  return getConflictById(x.insertId, conn);
}

/* ----------------------------- 事务支持 ----------------------------- */
async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    await conn.rollback();
    throw e;
  } finally {
    conn.release();
  }
}

module.exports = {
  mapUser, mapCanteen, mapElder, mapMeal, mapOrder, mapAuthorization, mapVerification, mapSyncBatch, mapConflict,
  getUserByUsername, getUserById, listUsers, createUser, updateUser, deleteUser, countUsers,
  listCanteens, getCanteenById, getCanteenByCode, createCanteen, updateCanteen, deleteCanteen,
  listElders, getElderById, getElderByCode, createElder, updateElder, deleteElder,
  listMeals, getMealById, createMeal, updateMeal, deleteMeal,
  listOrders, getOrderById, getOrderByElderAndMeal, createOrder, updateOrder,
  listAuthorizations, getAuthorizationById, findActiveAuthorization, createAuthorization, revokeAuthorization, updateAuthorization,
  listVerifications, getVerificationById, getVerificationByOfflineToken, getValidVerificationByElderAndMeal, createVerification, updateVerificationStatus,
  listSyncBatches, getSyncBatchById, getSyncBatchByCode, createSyncBatch, updateSyncBatch,
  listConflicts, getConflictById, createConflict,
  withTransaction,
};
