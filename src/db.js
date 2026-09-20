'use strict';

/**
 * Node 版数据层：node:sqlite 实现 src/app.js 需要的 store 接口。
 *
 * 接口里的方法全部返回 Promise —— 因为另一个实现（D1）天生是异步的，
 * 共享层统一 await，这里只做一层薄包装。
 */

const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (error) {
  console.error('');
  console.error('[启动失败] 需要 Node.js 内置的 node:sqlite 模块。');
  console.error(`当前 Node 版本：${process.version}`);
  console.error('需要 Node >= 22.13（该版本起不再需要 --experimental-sqlite 参数）。');
  console.error('若你在 22.5 ~ 22.12，可用：node --experimental-sqlite scripts/start.js');
  console.error('');
  throw error;
}

const SCHEMA_FILE = path.join(__dirname, '..', 'schema.sql');

function createStore(dataDir) {
  const dir = dataDir || path.join(__dirname, '..', 'data');
  fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(path.join(dir, 'chezai.db'));

  // PRAGMA 只放在这里，不放 schema.sql —— D1 不允许改这些。
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(fs.readFileSync(SCHEMA_FILE, 'utf8'));

  /* ---------------------------- 预编译语句 ---------------------------- */

  const stmt = {
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ),
    setSettingIfAbsent: db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'),

    listCars: db.prepare('SELECT * FROM cars ORDER BY created_at DESC'),
    getCar: db.prepare('SELECT * FROM cars WHERE id = ?'),
    insertCar: db.prepare(`
      INSERT INTO cars (id, plate, owner_name, phone, call_number, note, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateCar: db.prepare(`
      UPDATE cars SET plate = ?, owner_name = ?, phone = ?, call_number = ?, note = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `),
    deleteCar: db.prepare('DELETE FROM cars WHERE id = ?'),

    insertMessage: db.prepare(`
      INSERT INTO messages (car_id, kind, reason, content, contact, ip, ua, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    listMessages: db.prepare(`
      SELECT messages.*, cars.plate AS plate
      FROM messages LEFT JOIN cars ON cars.id = messages.car_id
      ORDER BY messages.created_at DESC
      LIMIT ?
    `),
    countUnread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL'),
    markRead: db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL'),
    markAllRead: db.prepare('UPDATE messages SET read_at = ? WHERE read_at IS NULL'),
    countRecentByIp: db.prepare(
      'SELECT COUNT(*) AS n FROM messages WHERE car_id = ? AND ip = ? AND created_at >= ?'
    ),
  };

  /* ---------------------- 登录限流（进程内滑动窗口） ------------------- */

  const rateBuckets = new Map();

  function bumpRateLimit(bucket, windowMs, limit) {
    const now = Date.now();
    let state = rateBuckets.get(bucket);
    if (!state || now >= state.resetAt) {
      state = { count: 0, resetAt: now + windowMs };
      rateBuckets.set(bucket, state);
    }
    if (rateBuckets.size > 5000) {
      for (const [key, value] of rateBuckets) {
        if (now >= value.resetAt) rateBuckets.delete(key);
      }
    }
    state.count += 1;
    return state.count <= limit;
  }

  /* ------------------------------- 接口 ------------------------------ */

  return {
    dataDir: dir,
    close: () => db.close(),

    async getSetting(key) {
      const row = stmt.getSetting.get(String(key));
      return row ? row.value : null;
    },

    async setSetting(key, value) {
      stmt.setSetting.run(String(key), String(value));
    },

    async setSettingIfAbsent(key, value) {
      stmt.setSettingIfAbsent.run(String(key), String(value));
    },

    async listCars() {
      return stmt.listCars.all();
    },

    async getCar(id) {
      return stmt.getCar.get(String(id)) || null;
    },

    async createCar(car) {
      const now = Date.now();
      stmt.insertCar.run(
        car.id,
        car.plate || '',
        car.owner_name || '',
        car.phone || '',
        car.call_number || '',
        car.note || '',
        car.enabled === 0 ? 0 : 1,
        now,
        now
      );
      return stmt.getCar.get(car.id) || null;
    },

    async updateCar(id, fields) {
      stmt.updateCar.run(
        fields.plate || '',
        fields.owner_name || '',
        fields.phone || '',
        fields.call_number || '',
        fields.note || '',
        fields.enabled === 0 ? 0 : 1,
        Date.now(),
        String(id)
      );
      return stmt.getCar.get(String(id)) || null;
    },

    async deleteCar(id) {
      return stmt.deleteCar.run(String(id)).changes > 0;
    },

    async addMessage(message) {
      const info = stmt.insertMessage.run(
        String(message.car_id),
        message.kind === 'call' ? 'call' : 'message',
        message.reason || '',
        message.content || '',
        message.contact || '',
        message.ip || '',
        message.ua || '',
        Date.now()
      );
      return Number(info.lastInsertRowid);
    },

    async listMessages(limit) {
      return stmt.listMessages.all(Number(limit) || 100);
    },

    async countUnread() {
      const row = stmt.countUnread.get();
      return row ? Number(row.n) : 0;
    },

    async markRead(id) {
      return stmt.markRead.run(Date.now(), Number(id)).changes > 0;
    },

    async markAllRead() {
      return stmt.markAllRead.run(Date.now()).changes;
    },

    async countRecentByIp(carId, ip, sinceMs) {
      const row = stmt.countRecentByIp.get(String(carId), String(ip), Number(sinceMs));
      return row ? Number(row.n) : 0;
    },

    async bumpRateLimit(bucket, windowMs, limit) {
      return bumpRateLimit(bucket, windowMs, limit);
    },
  };
}

module.exports = { createStore };
