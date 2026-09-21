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
    listCarsByOwner: db.prepare('SELECT * FROM cars WHERE owner_id = ? ORDER BY created_at DESC'),
    getCar: db.prepare('SELECT * FROM cars WHERE id = ?'),
    insertCar: db.prepare(`
      INSERT INTO cars (id, owner_id, plate, owner_name, phone, call_number, note, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateCar: db.prepare(`
      UPDATE cars SET plate = ?, owner_name = ?, phone = ?, call_number = ?, note = ?, enabled = ?, updated_at = ?
      WHERE id = ?
    `),
    setCarOwner: db.prepare('UPDATE cars SET owner_id = ?, updated_at = ? WHERE id = ?'),
    deleteCar: db.prepare('DELETE FROM cars WHERE id = ?'),
    deleteEmptyCars: db.prepare(`
      DELETE FROM cars
      WHERE COALESCE(plate, '') = '' AND COALESCE(phone, '') = '' AND COALESCE(call_number, '') = ''
    `),

    insertUser: db.prepare(`
      INSERT INTO users (id, contact, name, password_hash, role, disabled, created_at)
      VALUES (?, ?, ?, ?, ?, 0, ?)
    `),
    getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
    getUserByContact: db.prepare('SELECT * FROM users WHERE contact = ?'),
    listUsers: db.prepare(`
      SELECT users.*, (SELECT COUNT(*) FROM cars WHERE cars.owner_id = users.id) AS car_count
      FROM users ORDER BY users.created_at DESC
    `),
    countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
    setUserPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),

    insertCallLog: db.prepare(`
      INSERT INTO messages (car_id, kind, reason, content, contact, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    listMessages: db.prepare(`
      SELECT messages.*, cars.plate AS plate
      FROM messages LEFT JOIN cars ON cars.id = messages.car_id
      ORDER BY messages.created_at DESC
      LIMIT ?
    `),
    countUnread: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL'),
    listMessagesByOwner: db.prepare(`
      SELECT messages.*, cars.plate AS plate
      FROM messages JOIN cars ON cars.id = messages.car_id
      WHERE cars.owner_id = ?
      ORDER BY messages.created_at DESC
      LIMIT ?
    `),
    countUnreadByOwner: db.prepare(`
      SELECT COUNT(*) AS n
      FROM messages JOIN cars ON cars.id = messages.car_id
      WHERE cars.owner_id = ? AND messages.read_at IS NULL
    `),
    markReadByOwner: db.prepare(`
      UPDATE messages SET read_at = ?
      WHERE id = ? AND read_at IS NULL
        AND car_id IN (SELECT id FROM cars WHERE owner_id = ?)
    `),
    markAllReadByOwner: db.prepare(`
      UPDATE messages SET read_at = ?
      WHERE read_at IS NULL AND car_id IN (SELECT id FROM cars WHERE owner_id = ?)
    `),
    markRead: db.prepare('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL'),
    markAllRead: db.prepare('UPDATE messages SET read_at = ? WHERE read_at IS NULL'),

    /* ---------------------------- 贴纸编号 ---------------------------- */

    getCode: db.prepare('SELECT * FROM codes WHERE code = ?'),
    listCodes: db.prepare(`
      SELECT codes.*, cars.plate AS plate, cars.enabled AS car_enabled, users.contact AS owner_contact
      FROM codes
      LEFT JOIN cars ON cars.id = codes.car_id
      LEFT JOIN users ON users.id = codes.owner_id
      ORDER BY codes.created_at DESC
      LIMIT ?
    `),
    listCodesByOwner: db.prepare(`
      SELECT codes.*, cars.plate AS plate, cars.enabled AS car_enabled
      FROM codes LEFT JOIN cars ON cars.id = codes.car_id
      WHERE codes.owner_id = ?
      ORDER BY codes.created_at DESC
      LIMIT ?
    `),
    insertCode: db.prepare(`
      INSERT OR IGNORE INTO codes (code, car_id, owner_id, note, created_at, bound_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    bindCode: db.prepare('UPDATE codes SET car_id = ?, bound_at = ?, owner_id = ? WHERE code = ?'),
    unbindCode: db.prepare('UPDATE codes SET car_id = NULL, bound_at = NULL WHERE code = ?'),
    deleteCode: db.prepare('DELETE FROM codes WHERE code = ?'),
    deleteCodesByCar: db.prepare('DELETE FROM codes WHERE car_id = ?'),
    // 历史的「车辆编号」补成编号行：不跑也能扫码（resolveCode 有回落），跑了后台列表才完整
    adoptLegacyCodes: db.prepare(`
      INSERT OR IGNORE INTO codes (code, car_id, owner_id, note, created_at, bound_at)
      SELECT id, id, owner_id, '', created_at, created_at FROM cars
    `),
  };

  // 启动时补一次历史编号：幂等，几毫秒的事，省得线上还要记得手动跑迁移
  stmt.adoptLegacyCodes.run();

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

    async listCarsByOwner(ownerId) {
      return stmt.listCarsByOwner.all(String(ownerId));
    },

    async getCar(id) {
      return stmt.getCar.get(String(id)) || null;
    },

    async createCar(car) {
      const now = Date.now();
      stmt.insertCar.run(
        car.id,
        car.owner_id || null,
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

    async setCarOwner(id, ownerId) {
      return stmt.setCarOwner.run(ownerId || null, Date.now(), String(id)).changes > 0;
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

    async deleteEmptyCars() {
      return stmt.deleteEmptyCars.run().changes;
    },

    /* ------------------------------ 账号 ------------------------------ */

    async createUser(user) {
      stmt.insertUser.run(
        user.id,
        user.contact,
        user.name || '',
        user.password_hash,
        user.role === 'admin' ? 'admin' : 'owner',
        Date.now()
      );
      return stmt.getUser.get(user.id) || null;
    },

    async getUser(id) {
      return stmt.getUser.get(String(id)) || null;
    },

    async getUserByContact(contact) {
      return stmt.getUserByContact.get(String(contact)) || null;
    },

    async listUsers() {
      return stmt.listUsers.all();
    },

    async countUsers() {
      const row = stmt.countUsers.get();
      return row ? Number(row.n) : 0;
    },

    async setUserPassword(id, passwordHash) {
      return stmt.setUserPassword.run(String(passwordHash), String(id)).changes > 0;
    },

    async addCallLog(carId) {
      const info = stmt.insertCallLog.run(String(carId), 'call', '', '', '', Date.now());
      return Number(info.lastInsertRowid);
    },

    async listMessages(limit) {
      return stmt.listMessages.all(Number(limit) || 100);
    },

    async countUnread() {
      const row = stmt.countUnread.get();
      return row ? Number(row.n) : 0;
    },

    async listMessagesByOwner(ownerId, limit) {
      return stmt.listMessagesByOwner.all(String(ownerId), Number(limit) || 100);
    },

    async countUnreadByOwner(ownerId) {
      const row = stmt.countUnreadByOwner.get(String(ownerId));
      return row ? Number(row.n) : 0;
    },

    async markRead(id, ownerId) {
      if (ownerId) return stmt.markReadByOwner.run(Date.now(), Number(id), String(ownerId)).changes > 0;
      return stmt.markRead.run(Date.now(), Number(id)).changes > 0;
    },

    async markAllRead(ownerId) {
      if (ownerId) return stmt.markAllReadByOwner.run(Date.now(), String(ownerId)).changes;
      return stmt.markAllRead.run(Date.now()).changes;
    },

    async bumpRateLimit(bucket, windowMs, limit) {
      return bumpRateLimit(bucket, windowMs, limit);
    },

    /* ------------------------------ 贴纸编号 ------------------------------ */

    async getCode(code) {
      return stmt.getCode.get(String(code)) || null;
    },

    async listCodes(limit) {
      return stmt.listCodes.all(Number(limit) || 500);
    },

    async listCodesByOwner(ownerId, limit) {
      return stmt.listCodesByOwner.all(String(ownerId), Number(limit) || 500);
    },

    async createCode(entry) {
      stmt.insertCode.run(
        entry.code,
        entry.car_id || null,
        entry.owner_id || null,
        entry.note || '',
        Date.now(),
        entry.car_id ? Date.now() : null
      );
      return stmt.getCode.get(entry.code) || null;
    },

    /**
     * 绑定同时决定归属：谁把这张贴纸绑到车上，编号就归谁。
     * 否则「甲生成的空白贴纸被乙绑定」之后，甲还能在后台把它解绑 —— 跨租户漏洞。
     */
    async bindCode(code, carId, ownerId) {
      return (
        stmt.bindCode.run(carId || null, carId ? Date.now() : null, ownerId || null, String(code)).changes > 0
      );
    },

    async unbindCode(code) {
      return stmt.unbindCode.run(String(code)).changes > 0;
    },

    async deleteCode(code) {
      return stmt.deleteCode.run(String(code)).changes > 0;
    },

    /** 删车时把它的贴纸一起作废：车没了，贴在车上的码也该失效（不再「复活」成空白贴纸） */
    async deleteCodesByCar(carId) {
      return stmt.deleteCodesByCar.run(String(carId)).changes;
    },

    async adoptLegacyCodes() {
      return stmt.adoptLegacyCodes.run().changes;
    },
  };
}

module.exports = { createStore };
