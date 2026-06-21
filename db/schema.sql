-- 社区长者助餐运营管理平台 表结构（全程 utf8mb4，确保中文正常）
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  username      VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(64) NOT NULL,
  role          VARCHAR(16) NOT NULL DEFAULT 'VIEWER',
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 助餐点（社区食堂）
CREATE TABLE IF NOT EXISTS canteens (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code        VARCHAR(32) NOT NULL UNIQUE,
  name        VARCHAR(128) NOT NULL,
  district    VARCHAR(64) NOT NULL,
  address     VARCHAR(255) NOT NULL DEFAULT '',
  capacity    INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 长者档案
CREATE TABLE IF NOT EXISTS elders (
  id            INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  code          VARCHAR(32) NOT NULL UNIQUE,
  name          VARCHAR(64) NOT NULL,
  gender        VARCHAR(8) NOT NULL DEFAULT 'U',
  age           INT NOT NULL DEFAULT 0,
  phone         VARCHAR(32) NOT NULL DEFAULT '',
  subsidy_level VARCHAR(8) NOT NULL DEFAULT 'C',
  dietary       VARCHAR(255) NOT NULL DEFAULT '',
  canteen_id    INT UNSIGNED NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_elder_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 餐次（某助餐点某日某餐别提供的菜品）
CREATE TABLE IF NOT EXISTS meals (
  id          INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  canteen_id  INT UNSIGNED NOT NULL,
  serve_date  DATE NOT NULL,
  meal_type   VARCHAR(16) NOT NULL DEFAULT 'LUNCH',
  dish_name   VARCHAR(128) NOT NULL,
  price_cents INT NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_meal_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id) ON DELETE CASCADE,
  INDEX idx_meal_date (serve_date),
  INDEX idx_meal_canteen (canteen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 订餐
CREATE TABLE IF NOT EXISTS orders (
  id           INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id     INT UNSIGNED NOT NULL,
  meal_id      INT UNSIGNED NOT NULL,
  dining_type  VARCHAR(16) NOT NULL DEFAULT 'DINE_IN',
  qty          INT NOT NULL DEFAULT 1,
  amount_cents INT NOT NULL DEFAULT 0,
  subsidy_cents INT NOT NULL DEFAULT 0,
  pay_cents    INT NOT NULL DEFAULT 0,
  status       VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  created_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_order_elder FOREIGN KEY (elder_id) REFERENCES elders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_meal FOREIGN KEY (meal_id) REFERENCES meals(id) ON DELETE CASCADE,
  INDEX idx_order_status (status),
  INDEX idx_order_elder (elder_id),
  UNIQUE INDEX idx_elder_meal_unique (elder_id, meal_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 代领授权：长者授权某人在有效期内替自己取餐
CREATE TABLE IF NOT EXISTS pickup_authorizations (
  id             INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  elder_id       INT UNSIGNED NOT NULL,
  authorized_by  INT UNSIGNED NOT NULL,
  proxy_name     VARCHAR(64) NOT NULL,
  proxy_phone    VARCHAR(32) NOT NULL DEFAULT '',
  proxy_id_code  VARCHAR(32) NOT NULL,
  valid_from     DATETIME(3) NOT NULL,
  valid_until    DATETIME(3) NOT NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  revoked_at     DATETIME(3) NULL,
  revoked_by     INT UNSIGNED NULL,
  note           VARCHAR(255) NOT NULL DEFAULT '',
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_auth_elder FOREIGN KEY (elder_id) REFERENCES elders(id) ON DELETE CASCADE,
  CONSTRAINT fk_auth_creator FOREIGN KEY (authorized_by) REFERENCES users(id),
  INDEX idx_auth_elder (elder_id),
  INDEX idx_auth_proxy (proxy_id_code),
  INDEX idx_auth_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 核销记录：每次取餐核销的完整留痕（本人领 / 代领 / 离线补传）
CREATE TABLE IF NOT EXISTS verification_records (
  id                INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  order_id          INT UNSIGNED NOT NULL,
  elder_id          INT UNSIGNED NOT NULL,
  meal_id           INT UNSIGNED NOT NULL,
  canteen_id        INT UNSIGNED NOT NULL,
  verifier_id       INT UNSIGNED NULL,
  pickup_type       VARCHAR(16) NOT NULL DEFAULT 'SELF',
  proxy_auth_id     INT UNSIGNED NULL,
  proxy_name        VARCHAR(64) NULL,
  proxy_id_code     VARCHAR(32) NULL,
  verify_channel    VARCHAR(16) NOT NULL DEFAULT 'ONLINE',
  offline_token     VARCHAR(64) NULL UNIQUE,
  verified_at       DATETIME(3) NOT NULL,
  synced_at         DATETIME(3) NULL,
  sync_batch_id     INT UNSIGNED NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'VALID',
  conflict_note     VARCHAR(255) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ver_order FOREIGN KEY (order_id) REFERENCES orders(id),
  CONSTRAINT fk_ver_elder FOREIGN KEY (elder_id) REFERENCES elders(id),
  CONSTRAINT fk_ver_meal FOREIGN KEY (meal_id) REFERENCES meals(id),
  CONSTRAINT fk_ver_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id),
  CONSTRAINT fk_ver_verifier FOREIGN KEY (verifier_id) REFERENCES users(id),
  CONSTRAINT fk_ver_auth FOREIGN KEY (proxy_auth_id) REFERENCES pickup_authorizations(id),
  INDEX idx_ver_order (order_id),
  INDEX idx_ver_elder_meal (elder_id, meal_id),
  INDEX idx_ver_status (status),
  INDEX idx_ver_verified (verified_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 离线补传批次：助餐点断网恢复后批量上报核销记录
CREATE TABLE IF NOT EXISTS offline_sync_batches (
  id             INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  canteen_id     INT UNSIGNED NOT NULL,
  operator_id    INT UNSIGNED NOT NULL,
  batch_code     VARCHAR(64) NOT NULL UNIQUE,
  record_count   INT NOT NULL DEFAULT 0,
  processed_at   DATETIME(3) NULL,
  status         VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  summary        TEXT NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_batch_canteen FOREIGN KEY (canteen_id) REFERENCES canteens(id),
  CONSTRAINT fk_batch_operator FOREIGN KEY (operator_id) REFERENCES users(id),
  INDEX idx_batch_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 核销冲突记录：离线补传时与线上状态冲突的裁决留痕
CREATE TABLE IF NOT EXISTS verification_conflicts (
  id                INT UNSIGNED PRIMARY KEY AUTO_INCREMENT,
  sync_batch_id     INT UNSIGNED NULL,
  order_id          INT UNSIGNED NOT NULL,
  offline_token     VARCHAR(64) NULL,
  offline_verified_at DATETIME(3) NOT NULL,
  existing_status   VARCHAR(16) NOT NULL,
  existing_verified_at DATETIME(3) NULL,
  conflict_type     VARCHAR(32) NOT NULL,
  resolution        VARCHAR(16) NOT NULL,
  note              VARCHAR(255) NULL,
  created_at        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_conflict_batch FOREIGN KEY (sync_batch_id) REFERENCES offline_sync_batches(id) ON DELETE SET NULL,
  CONSTRAINT fk_conflict_order FOREIGN KEY (order_id) REFERENCES orders(id),
  INDEX idx_conflict_order (order_id),
  INDEX idx_conflict_type (conflict_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
