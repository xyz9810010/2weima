'use strict';

/**
 * 共享核心：**不依赖任何 Node 内置模块**，Node 22 与 Cloudflare Workers 都能跑。
 *
 * 只用到三个两个平台都有的全局能力：
 *   - globalThis.crypto.getRandomValues / subtle（Node 19+ 已把 WebCrypto 挂到全局）
 *   - TextEncoder / btoa
 *   - URL / URLSearchParams
 *
 * 凡是平台相关的东西（socket、D1、scrypt）一律不在这里，见 src/server.js 与 src/worker.js。
 */

/* ------------------------------ 配置 ------------------------------ */

// 页面时间显示用的时区偏移，由各平台入口在启动时设置一次
let tzOffsetHours = 8;

function setTimeZoneOffset(hours) {
  const value = Number(hours);
  tzOffsetHours = Number.isFinite(value) ? value : 8;
}

/* ---------------------------- 字符串工具 --------------------------- */

/** HTML 转义（文本与属性值通用） */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(value, max) {
  const s = String(value === null || value === undefined ? '' : value);
  return s.length > max ? s.slice(0, max) : s;
}

function normalizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

/** 只保留数字与开头的 +，用于 tel: 链接 */
function sanitizePhone(value) {
  const cleaned = String(value || '').replace(/[^\d+]/g, '');
  return cleaned.replace(/(?!^)\+/g, '');
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + tzOffsetHours * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
}

/** application/x-www-form-urlencoded → 普通对象 */
function parseForm(raw) {
  const out = {};
  for (const [key, value] of new URLSearchParams(raw || '')) {
    out[key] = value;
  }
  return out;
}

/* ------------------------------ 头处理 ----------------------------- */

function parseCookies(headerValue) {
  const out = {};
  if (!headerValue) return out;
  for (const part of String(headerValue).split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/* ------------------------------ 随机 ------------------------------- */

/** 去掉容易看错的 0/O/1/l/I，方便贴纸上人工读编号 */
const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** 无取模偏差的随机编号 */
function randomCode(length = 10) {
  const base = CODE_ALPHABET.length;
  const ceiling = Math.floor(256 / base) * base; // 232：丢弃 >=232 的字节，避免偏差
  let out = '';
  const buffer = new Uint8Array(length * 2);
  while (out.length < length) {
    crypto.getRandomValues(buffer);
    for (const byte of buffer) {
      if (byte >= ceiling) continue;
      out += CODE_ALPHABET[byte % base];
      if (out.length === length) break;
    }
  }
  return out;
}

function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/* ------------------------- 比较与签名（WebCrypto） ------------------- */

const encoder = new TextEncoder();

/** 长度固定时才是常数时间；长度不同直接返回 false */
function timingSafeEqualStr(a, b) {
  const x = encoder.encode(String(a));
  const y = encoder.encode(String(b));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacBase64Url(payload, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return base64Url(new Uint8Array(signature));
}

async function signValue(payload, secret) {
  return `${payload}.${await hmacBase64Url(payload, secret)}`;
}

async function unsignValue(token, secret) {
  const raw = String(token || '');
  const index = raw.lastIndexOf('.');
  if (index <= 0) return null;
  const payload = raw.slice(0, index);
  const mac = raw.slice(index + 1);
  const expected = await hmacBase64Url(payload, secret);
  return timingSafeEqualStr(mac, expected) ? payload : null;
}

/* --------------------------- 会话密钥获取 --------------------------- */

/**
 * 没有显式配置时，生成一个并写进数据库（用 INSERT OR IGNORE 避免多实例竞争）。
 * 多实例部署时建议直接配 SESSION_SECRET，别依赖这个。
 */
async function resolveSessionSecret(store, fromConfig) {
  if (fromConfig) return fromConfig;

  let secret = await store.getSetting('session_secret');
  if (secret) return secret;

  const candidate = randomHex(32);
  await store.setSettingIfAbsent('session_secret', candidate);
  secret = await store.getSetting('session_secret');
  return secret || candidate;
}

module.exports = {
  setTimeZoneOffset,
  esc,
  truncate,
  normalizeBaseUrl,
  sanitizePhone,
  fmtTime,
  parseForm,
  parseCookies,
  randomCode,
  randomHex,
  timingSafeEqualStr,
  signValue,
  unsignValue,
  resolveSessionSecret,
  CODE_ALPHABET,
};
