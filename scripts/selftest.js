'use strict';

/**
 * 二维码编码器自检：node scripts/selftest.js
 *
 * 没有外部依赖，也没有解码器，所以这里用三类"真实判据"来验证：
 *   1. 与 ISO/IEC 18004 规范里已知的表格/常量逐条比对（容量表、格式信息、版本信息）
 *   2. Reed-Solomon 的数学性质：c(α^i) = 0（解码器第一步就是算这个）
 *   3. 结构检查：矩阵尺寸、定位图形、定时图形、固定黑点、两份格式信息是否一致
 * 最后打印一个真实二维码的字符画，可以直接用手机扫一下做最终确认。
 */

const qr = require('../src/qr');

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function equal(name, actual, expected) {
  check(name, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

/* ------------------------------------------------------------------ */
console.log('\n[1/4] 容量表（纠错等级 M 的 byte 模式上限）');

const EXPECTED_CAPACITY = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213];
for (let v = 1; v <= qr.MAX_VERSION; v++) {
  equal(`版本 ${v} 容量`, qr.byteCapacity(v), EXPECTED_CAPACITY[v - 1]);
}

/* ------------------------------------------------------------------ */
console.log('\n[2/4] 格式信息 / 版本信息常量');

// 规范 Table C.1：纠错等级 M 的 8 个格式信息串（掩码 0-7），转成十进制
const EXPECTED_FORMAT_M = [
  0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011,
  0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000,
];
for (let mask = 0; mask < 8; mask++) {
  equal(`格式信息 M/掩码${mask}`, qr.formatBits(qr.EC_LEVEL_M, mask), EXPECTED_FORMAT_M[mask]);
}

// 规范 Table D.1：版本信息串
equal('版本信息 v7', qr.versionBits(7), 0b000111110010010100);
equal('版本信息 v8', qr.versionBits(8), 0b001000010110111100);
equal('版本信息 v10', qr.versionBits(10), 0b001010010011010011);

/* ------------------------------------------------------------------ */
console.log('\n[3/4] Reed-Solomon 数学性质：c(α^i) = 0');

function evalPoly(coeffs, x) {
  let y = 0;
  for (const c of coeffs) y = qr.gfMul(y, x) ^ c;
  return y;
}

function alpha(power) {
  // α 就是 2，反复乘出来即可，避免依赖模块内部表
  let value = 1;
  for (let i = 0; i < power; i++) {
    value = qr.gfMul(value, 2);
  }
  return value;
}

let syndromeOk = true;
for (const degree of [10, 16, 18, 22, 24, 26]) {
  const data = Uint8Array.from({ length: 20 }, (_, i) => (i * 37 + degree) & 0xff);
  const ec = qr.rsEncode(data, degree);
  const codeword = Array.from(data).concat(Array.from(ec));
  for (let i = 0; i < degree; i++) {
    if (evalPoly(codeword, alpha(i)) !== 0) {
      syndromeOk = false;
      console.log(`    纠错长度 ${degree}：α^${i} 处校验值不为 0`);
    }
  }
}
check('所有测试向量的伴随式全为 0', syndromeOk);

/* ------------------------------------------------------------------ */
console.log('\n[4/4] 矩阵结构');

const SAMPLES = [
  'https://move.example.com/c/Ab3xK9pQ2z',
  'http://localhost:3000/c/zK9pQ2x7Lm',
  'A',
  'x'.repeat(213),
];

for (const sample of SAMPLES) {
  const label = sample.length > 24 ? `${sample.slice(0, 12)}…(${sample.length}字节)` : sample;
  let code;
  try {
    code = qr.encode(sample);
  } catch (error) {
    check(`编码 ${label}`, false, error.message);
    continue;
  }

  const { size, matrix, version, mask } = code;
  equal(`${label} 矩阵尺寸`, size, version * 4 + 17);

  // 三个定位图形必须完好无损
  const finderOk = [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ].every(([top, left]) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const dark = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        if (matrix[top + r][left + c] !== (dark ? 1 : 0)) return false;
      }
    }
    return true;
  });
  check(`${label} 定位图形`, finderOk);

  // 定时图形必须黑白交替
  let timingOk = true;
  for (let i = 8; i < size - 8; i++) {
    const expected = i % 2 === 0 ? 1 : 0;
    if (matrix[6][i] !== expected || matrix[i][6] !== expected) timingOk = false;
  }
  check(`${label} 定时图形`, timingOk);

  equal(`${label} 固定黑点`, matrix[size - 8][8], 1);

  // 两份格式信息必须一致，且等于按掩码算出来的值
  const bits = qr.formatBits(qr.EC_LEVEL_M, mask);
  let copy1 = 0;
  for (let i = 0; i <= 5; i++) if (matrix[i][8]) copy1 |= 1 << i;
  if (matrix[7][8]) copy1 |= 1 << 6;
  if (matrix[8][8]) copy1 |= 1 << 7;
  if (matrix[8][7]) copy1 |= 1 << 8;
  for (let i = 9; i < 15; i++) if (matrix[8][14 - i]) copy1 |= 1 << i;

  let copy2 = 0;
  for (let i = 0; i < 8; i++) if (matrix[8][size - 1 - i]) copy2 |= 1 << i;
  for (let i = 8; i < 15; i++) if (matrix[size - 15 + i][8]) copy2 |= 1 << i;

  check(`${label} 两份格式信息一致`, copy1 === copy2, `副本1=${copy1}，副本2=${copy2}`);
  equal(`${label} 格式信息内容`, copy1, bits);
}

// 超长内容应当明确报错，而不是默默截断
let oversized = false;
try {
  qr.encode('x'.repeat(214));
} catch {
  oversized = true;
}
check('超过 213 字节时抛错', oversized);

/* ------------------------------------------------------------------ */

const total = passed + failures.length;
console.log(`\n结果：${passed}/${total} 项通过`);
if (failures.length) {
  console.log('\n失败项：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}

const demo = 'https://move.example.com/c/Ab3xK9pQ2z';
const info = qr.encode(demo);
console.log(`\n示例：${demo}`);
console.log(`版本 ${info.version}，尺寸 ${info.size}x${info.size}，掩码 ${info.mask}`);
console.log('请用手机扫下面这个二维码确认（终端字体需等宽）：\n');
console.log(qr.toAscii(demo));
console.log('');
