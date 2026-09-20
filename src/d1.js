'use strict';

/**
 * Cloudflare Workers 版数据层：D1 实现 src/app.js 需要的 store 接口。
 *
 * 接口与 src/db.js（node:sqlite）完全一致，所以共享层不用改一行。
 * 表结构见根目录 schema.sql，用 wrangler d1 execute 导入。
 */

function createStore(db) {
  if (!db) {
    throw new Error(
      'D1 绑定缺失：wrangler.toml 里需要有 [[d1_databases]] binding = "DB"，' +
        '并且已经执行过 wrangler d1 create 与 d1 execute --file=./schema.sql'
    );
  }

  const run = async (sql, ...args) => db.prepare(sql).bind(...args).run();
  const first = async (sql, ...args) => (await db.prepare(sql).bind(...args).first()) || null;
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...args).all()).results || [];

  async function bumpRateLimit(bucket, windowMs, limit) {
    const now = Date.now();
    const row = await first('SELECT count, reset_at FROM rate_limits WHERE bucket = ?', bucket);

    if (!row || row.reset_at <= now) {
      await run(
        `INSERT INTO rate_limits (bucket, count, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = 1, reset_at = excluded.reset_at`,
        bucket,
        now + windowMs
      );
      return limit >= 1;
    }

    if (row.count >= limit) return false;

    await run('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?', bucket);
    return true;
  }

  return {
    async getSetting(key) {
      const row = await first('SELECT value FROM settings WHERE key = ?', String(key));
      return row ? row.value : null;
    },

    async setSetting(key, value) {
      await run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        String(key),
        String(value)
      );
    },

    async setSettingIfAbsent(key, value) {
      await run('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', String(key), String(value));
    },

    async listCars() {
      return all('SELECT * FROM cars ORDER BY created_at DESC');
    },

    async listCarsByOwner(ownerId) {
      return all('SELECT * FROM cars WHERE owner_id = ? ORDER BY created_at DESC', String(ownerId));
    },

    async getCar(id) {
      return first('SELECT * FROM cars WHERE id = ?', String(id));
    },

    async createCar(car) {
      const now = Date.now();
      await run(
        `INSERT INTO cars (id, owner_id, plate, owner_name, phone, call_number, note, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      return first('SELECT * FROM cars WHERE id = ?', car.id);
    },

    async setCarOwner(id, ownerId) {
      const result = await run('UPDATE cars SET owner_id = ?, updated_at = ? WHERE id = ?', ownerId || null, Date.now(), String(id));
      return Boolean(result.meta && result.meta.changes);
    },

    async updateCar(id, fields) {
      await run(
        `UPDATE cars SET plate = ?, owner_name = ?, phone = ?, call_number = ?, note = ?,
         enabled = ?, updated_at = ? WHERE id = ?`,
        fields.plate || '',
        fields.owner_name || '',
        fields.phone || '',
        fields.call_number || '',
        fields.note || '',
        fields.enabled === 0 ? 0 : 1,
        Date.now(),
        String(id)
      );
      return first('SELECT * FROM cars WHERE id = ?', String(id));
    },

    async deleteCar(id) {
      const result = await run('DELETE FROM cars WHERE id = ?', String(id));
      return Boolean(result.meta && result.meta.changes);
    },

    /* ------------------------------ 账号 ------------------------------ */

    async createUser(user) {
      await run(
        `INSERT INTO users (id, contact, name, password_hash, role, disabled, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
        user.id,
        user.contact,
        user.name || '',
        user.password_hash,
        user.role === 'admin' ? 'admin' : 'owner',
        Date.now()
      );
      return first('SELECT * FROM users WHERE id = ?', user.id);
    },

    async getUser(id) {
      return first('SELECT * FROM users WHERE id = ?', String(id));
    },

    async getUserByContact(contact) {
      return first('SELECT * FROM users WHERE contact = ?', String(contact));
    },

    async listUsers() {
      return all(
        `SELECT users.*, (SELECT COUNT(*) FROM cars WHERE cars.owner_id = users.id) AS car_count
         FROM users ORDER BY users.created_at DESC`
      );
    },

    async countUsers() {
      const row = await first('SELECT COUNT(*) AS n FROM users');
      return row ? Number(row.n) : 0;
    },

    async setUserPassword(id, passwordHash) {
      const result = await run('UPDATE users SET password_hash = ? WHERE id = ?', String(passwordHash), String(id));
      return Boolean(result.meta && result.meta.changes);
    },

    async addCallLog(carId) {
      const result = await run(
        `INSERT INTO messages (car_id, kind, reason, content, contact, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        String(carId),
        'call',
        '',
        '',
        '',
        Date.now()
      );
      return result.meta ? Number(result.meta.last_row_id) : 0;
    },

    async listMessages(limit) {
      return all(
        `SELECT messages.*, cars.plate AS plate
         FROM messages LEFT JOIN cars ON cars.id = messages.car_id
         ORDER BY messages.created_at DESC
         LIMIT ?`,
        Number(limit) || 100
      );
    },

    async countUnread() {
      const row = await first('SELECT COUNT(*) AS n FROM messages WHERE read_at IS NULL');
      return row ? Number(row.n) : 0;
    },

    async listMessagesByOwner(ownerId, limit) {
      return all(
        `SELECT messages.*, cars.plate AS plate
         FROM messages JOIN cars ON cars.id = messages.car_id
         WHERE cars.owner_id = ?
         ORDER BY messages.created_at DESC
         LIMIT ?`,
        String(ownerId),
        Number(limit) || 100
      );
    },

    async countUnreadByOwner(ownerId) {
      const row = await first(
        `SELECT COUNT(*) AS n
         FROM messages JOIN cars ON cars.id = messages.car_id
         WHERE cars.owner_id = ? AND messages.read_at IS NULL`,
        String(ownerId)
      );
      return row ? Number(row.n) : 0;
    },

    async markRead(id, ownerId) {
      const result = ownerId
        ? await run(
            `UPDATE messages SET read_at = ?
             WHERE id = ? AND read_at IS NULL
               AND car_id IN (SELECT id FROM cars WHERE owner_id = ?)`,
            Date.now(),
            Number(id),
            String(ownerId)
          )
        : await run('UPDATE messages SET read_at = ? WHERE id = ? AND read_at IS NULL', Date.now(), Number(id));
      return Boolean(result.meta && result.meta.changes);
    },

    async markAllRead(ownerId) {
      const result = ownerId
        ? await run(
            `UPDATE messages SET read_at = ?
             WHERE read_at IS NULL AND car_id IN (SELECT id FROM cars WHERE owner_id = ?)`,
            Date.now(),
            String(ownerId)
          )
        : await run('UPDATE messages SET read_at = ? WHERE read_at IS NULL', Date.now());
      return result.meta ? Number(result.meta.changes) : 0;
    },

    async bumpRateLimit(bucket, windowMs, limit) {
      return bumpRateLimit(bucket, windowMs, limit);
    },
  };
}

module.exports = { createStore };
