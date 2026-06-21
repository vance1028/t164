-- =====================================================================
-- 迁移脚本：为 verification_records 增加并发安全的部分唯一约束
-- ---------------------------------------------------------------------
-- 目的：保证同一订单、同一(长者+餐次)在任意并发下只能存在一条
--       status='VALID' 的核销记录，杜绝"先查后写"竞态导致的重复核销。
--
-- 原理：MySQL 不支持 PostgreSQL 风格的部分唯一索引，但可用
--       「生成列 + 唯一索引」实现等价语义：
--         当 status='VALID' 时生成列 = 业务键，否则 = NULL；
--         InnoDB 的 UNIQUE 索引允许多个 NULL 并存，
--         因此仅 VALID 记录会触发唯一冲突，SUPERSEDED 历史记录互不干扰。
--
-- 前置要求：MySQL >= 8.0（生成列 VIRTUAL + 二级索引）。
-- 执行前请备份 verification_records 表。
-- 可重复执行：每步均先判断/清理，已存在则跳过。
-- =====================================================================

START TRANSACTION;

-- 1) 历史脏数据清理：若同(elder_id, meal_id)存在多条 VALID，
--    仅保留最早一条（verified_at 升序、id 升序），其余降级为 SUPERSEDED。
UPDATE verification_records
SET status = 'SUPERSEDED',
    conflict_note = CONCAT(IFNULL(conflict_note, ''), ' [迁移去重：同长者同餐次存在更早的 VALID 记录]')
WHERE status = 'VALID'
  AND id NOT IN (
    SELECT min_id FROM (
      SELECT MIN(id) AS min_id
      FROM verification_records
      WHERE status = 'VALID'
      GROUP BY elder_id, meal_id
    ) t
  );

-- 同一 order_id 多条 VALID 同理（保留最早一条）
UPDATE verification_records
SET status = 'SUPERSEDED',
    conflict_note = CONCAT(IFNULL(conflict_note, ''), ' [迁移去重：同一订单存在更早的 VALID 记录]')
WHERE status = 'VALID'
  AND id NOT IN (
    SELECT min_id FROM (
      SELECT MIN(id) AS min_id
      FROM verification_records
      WHERE status = 'VALID'
      GROUP BY order_id
    ) t
  );

-- 2) 增加生成列（若不存在）。MySQL 8.0.29 以下不支持 ADD COLUMN IF NOT EXISTS，
--    此处用 information_schema 预存判断结果动态拼接，保证幂等。
SET @col1 := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'verification_records' AND column_name = 'valid_order_key');
SET @col2 := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'verification_records' AND column_name = 'valid_elder_meal_key');

SET @sql := IF(@col1 = 0,
  'ALTER TABLE verification_records ADD COLUMN valid_order_key INT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status=''VALID'' THEN order_id ELSE NULL END) VIRTUAL',
  'SELECT ''valid_order_key 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@col2 = 0,
  'ALTER TABLE verification_records ADD COLUMN valid_elder_meal_key VARCHAR(60) GENERATED ALWAYS AS (CASE WHEN status=''VALID'' THEN CONCAT(elder_id,''_'',meal_id) ELSE NULL END) VIRTUAL',
  'SELECT ''valid_elder_meal_key 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3) 增加唯一索引（若不存在）
SET @idx1 := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'verification_records' AND index_name = 'uq_ver_valid_order');
SET @sql := IF(@idx1 = 0,
  'ALTER TABLE verification_records ADD UNIQUE INDEX uq_ver_valid_order (valid_order_key)',
  'SELECT ''uq_ver_valid_order 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx2 := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = DATABASE() AND table_name = 'verification_records' AND index_name = 'uq_ver_valid_elder_meal');
SET @sql := IF(@idx2 = 0,
  'ALTER TABLE verification_records ADD UNIQUE INDEX uq_ver_valid_elder_meal (valid_elder_meal_key)',
  'SELECT ''uq_ver_valid_elder_meal 已存在，跳过'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

COMMIT;

-- 4) 校验：迁移后不应再存在同(elder_id,meal_id)多条 VALID
SELECT elder_id, meal_id, COUNT(*) AS valid_count
FROM verification_records
WHERE status = 'VALID'
GROUP BY elder_id, meal_id
HAVING COUNT(*) > 1;

SELECT order_id, COUNT(*) AS valid_count
FROM verification_records
WHERE status = 'VALID'
GROUP BY order_id
HAVING COUNT(*) > 1;
-- 以上两个查询结果应为空；若有行返回，说明迁移未完全去重，需人工排查。
