-- 挪车码 · 表结构
--
-- 这一份 SQL 两边共用：
--   Node    : src/db.js 启动时 exec 它
--   Workers : wrangler d1 execute chezai-qrcode --remote --file=./schema.sql
--
-- 所以这里只有纯 DDL：
--   - 不要加 PRAGMA（D1 不允许改 journal_mode / foreign_keys）
--   - 刻意不用 STRICT 表（D1 的 SQLite 版本支持情况随环境而变，而这里所有写入都过我们自己的代码）

-- 车主账号。
-- 每个车主一个账号，只能看到和管理自己的车。
-- contact 用手机号或邮箱，二选一即可（同一字段，登录时凭它找账号）。
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  contact       TEXT NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'owner',   -- owner = 车主；admin = 平台方
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

-- 登录靠 contact 查找，所以要唯一；同时它也是防重复注册的关键
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_contact ON users (contact);

CREATE TABLE IF NOT EXISTS cars (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- 空 = 平台方自己录的车
  plate       TEXT NOT NULL DEFAULT '',
  owner_name  TEXT NOT NULL DEFAULT '',
  phone       TEXT NOT NULL DEFAULT '',
  call_number TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cars_owner ON cars (owner_id, created_at DESC);

-- 拨号记录。
-- 表名 messages 是历史遗留（早期版本这里存扫码人的留言），现在一行 = 一次拨号打点。
--
-- 刻意没有 ip / ua 这类列：不存储任何能指向扫码人的信息。
-- 一行记录只有「哪辆车、什么时候、读没读」。
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  car_id     TEXT NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'call',
  reason     TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  contact    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_messages_car ON messages (car_id, created_at DESC);

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
