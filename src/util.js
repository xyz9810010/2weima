'use strict';

/**
 * Node 适配层专用工具。
 *
 * 共享层（src/core.js）不用这里的任何东西；这里只处理
 * 「Node 独有的东西」：读 socket 里的请求体、scrypt 口令、转发头。
 *
 * Cloudflare Workers 里没有这些（也没有 scrypt），对应实现见 src/worker.js。
 */

const crypto = require('node:crypto');

/* ---------------------------- 请求体读取 ---------------------------- */

function readBody(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------ 口令 ------------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 32);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (!salt.length || !expected.length) return false;

  let derived;
  try {
    derived = crypto.scryptSync(String(password), salt, expected.length);
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/* ------------------------------ 请求头 ------------------------------ */

/** node:http 的 headers 已经全是小写键，这里只做一次浅拷贝并补默认值 */
function normalizeHeaders(headers) {
  const out = {};
  for (const key of Object.keys(headers || {})) {
    const value = headers[key];
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value || '');
  }
  return out;
}

/**
 * 取客户端 IP。默认只信 socket 地址；
 * 只有在反向代理后面（TRUST_PROXY=1）才读 X-Forwarded-For。
 */
function clientIp(req, headers, trustProxy) {
  if (trustProxy) {
    const forwarded = headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

module.exports = {
  readBody,
  hashPassword,
  verifyPassword,
  normalizeHeaders,
  clientIp,
};
