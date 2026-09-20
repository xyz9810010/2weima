-- 挪车码 · 表结构
--
-- 这一份 SQL 两边共用：
--   Node    : src/db.js 启动时 exec 它
--   Workers : wrangler d1 execute chezai-qrcode --remote --file=./schema.sql
--
-- 所以这里只有纯 DDL：
--   - 不要加 PRAGMA（D1 不允许改 journal_mode / foreign_keys）
--   - 刻意不用 STRICT 表（D1 的 SQLite 版本支持情况随环境而变，而这里所有写入都过我们自己的代码）

CREATE TABLE IF NOT EXISTS cars (
  id          TEXT PRIMARY KEY,
  plate       TEXT NOT NULL DEFAULT '',
  owner_name  TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  call_number TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id     TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'message',
  reason     TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  ip         TEXT NOT NULL DEFAULT '',
  ua         TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_car ON messages (car_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_ip ON messages (car_id, ip, created_at);

-- 扫码方限流直接用 messages 表统计，这里只服务后台登录限流
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket   TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
