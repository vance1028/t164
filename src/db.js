'use strict';

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

/** MySQL 连接管理（mysql2/promise 连接池，全程 utf8mb4）。 */

const DB_CONFIG = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT) || 13377,
  user: process.env.DB_USER || 'care',
  password: process.env.DB_PASSWORD || 'carepass',
  database: process.env.DB_NAME || 'eldercare',
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
};

let pool = null;

function getPool() {
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

async function ensureSchema() {
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  const conn = await mysql.createConnection({ ...DB_CONFIG, multipleStatements: true });
  try {
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  await migrateSchema();
}

async function migrateSchema() {
  const pool = getPool();
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'verification_records'
       AND COLUMN_NAME IN ('valid_order_key','valid_elder_meal_key')`
  );
  const hasCol = new Set(cols.map((c) => c.COLUMN_NAME));
  if (!hasCol.has('valid_order_key')) {
    await pool.query(
      `ALTER TABLE verification_records ADD COLUMN valid_order_key INT UNSIGNED
       GENERATED ALWAYS AS (CASE WHEN status='VALID' THEN order_id ELSE NULL END) VIRTUAL`
    );
  }
  if (!hasCol.has('valid_elder_meal_key')) {
    await pool.query(
      `ALTER TABLE verification_records ADD COLUMN valid_elder_meal_key VARCHAR(60)
       GENERATED ALWAYS AS (CASE WHEN status='VALID' THEN CONCAT(elder_id,'_',meal_id) ELSE NULL END) VIRTUAL`
    );
  }
  const [idxs] = await pool.query(
    `SELECT DISTINCT INDEX_NAME FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = 'verification_records'
       AND INDEX_NAME IN ('uq_ver_valid_order','uq_ver_valid_elder_meal')`
  );
  const hasIdx = new Set(idxs.map((i) => i.INDEX_NAME));
  if (!hasIdx.has('uq_ver_valid_order')) {
    await pool.query(`ALTER TABLE verification_records ADD UNIQUE INDEX uq_ver_valid_order (valid_order_key)`);
  }
  if (!hasIdx.has('uq_ver_valid_elder_meal')) {
    await pool.query(`ALTER TABLE verification_records ADD UNIQUE INDEX uq_ver_valid_elder_meal (valid_elder_meal_key)`);
  }
}

async function resetAll() {
  const conn = await getPool().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of [
      'verification_conflicts',
      'verification_records',
      'offline_sync_batches',
      'pickup_authorizations',
      'orders',
      'meals',
      'elders',
      'canteens',
      'users',
    ]) {
      await conn.query(`TRUNCATE TABLE ${t}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

async function waitForDb(retries = 60, delayMs = 1000) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const conn = await mysql.createConnection({ ...DB_CONFIG, database: undefined });
      await conn.end();
      return true;
    } catch (e) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('数据库连接超时');
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { getPool, ensureSchema, migrateSchema, resetAll, waitForDb, close, DB_CONFIG };
