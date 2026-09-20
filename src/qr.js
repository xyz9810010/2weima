'use strict';

/**
 * 零依赖二维码编码器（byte 模式 / 纠错等级 M / 版本 1-10）
 *
 * 只做挪车贴纸需要的那一件事：把一段 URL 变成可打印的 SVG。
 * 刻意限制到版本 1-10（M 级最大 213 字节），足够放
 * "https://your-domain/c/Ab3xK9pQ2z" 这样的短链。
 *
 * 实现依据 ISO/IEC 18004：
 *   - 数据编码：byte 模式（0100）+ 字符计数 + 终止符 + 填充字节
 *   - 纠错：GF(256) 上的 Reed-Solomon（本原多项式 0x11D）
 *   - 分块交织：data codewords 与 ec codewords 分别按列交织
 *   - 掩码：8 种模式按 4 条罚分规则选最优
 */

// 纠错等级 M 的编码位（L=01, M=00, Q=11, H=10）
const EC_LEVEL_M = 0b00;

// 版本 -> [每块纠错码字数, 组1块数, 组1每块数据码字, 组2块数, 组2每块数据码字]
const BLOCKS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

// 版本 -> 校正图形中心坐标（行列共用同一组坐标）
const ALIGN_M = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const MAX_VERSION = 10;

/* ------------------------------------------------------------------ */
/* GF(256) 与 Reed-Solomon                                            */
/* ------------------------------------------------------------------ */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 degree 次的 RS 生成多项式，系数从最高次项开始 */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** 对 data 求 degree 个纠错码字 */
function rsEncode(data, degree) {
  const gen = rsGenerator(degree);
  const buf = new Uint8Array(data.length + degree);
  buf.set(data, 0);
  for (let i = 0; i < data.length; i++) {
    const coef = buf[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) {
      buf[i + j] ^= gfMul(gen[j], coef);
    }
  }
  return buf.slice(data.length);
}

/* ------------------------------------------------------------------ */
/* 容量与数据编码                                                      */
/* ------------------------------------------------------------------ */

function dataCodewordCount(version) {
  const [, b1, d1, b2, d2] = BLOCKS_M[version];
  return b1 * d1 + b2 * d2;
}

/** 该版本在 byte 模式下最多能装多少字节（含模式位与字符计数） */
function byteCapacity(version) {
  const countBits = version < 10 ? 8 : 16;
  return Math.floor((dataCodewordCount(version) * 8 - 4 - countBits) / 8);
}

function pickVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (byteLength <= byteCapacity(v)) return v;
  }
  return 0;
}

/** 生成数据码字：模式 + 计数 + 内容 + 终止符 + 字节对齐 + 填充 */
function buildDataCodewords(bytes, version) {
  const totalData = dataCodewordCount(version);
  const capacityBits = totalData * 8;
  const bits = [];

  const put = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  put(0b0100, 4); // byte 模式
  put(bytes.length, version < 10 ? 8 : 16);
  for (let i = 0; i < bytes.length; i++) put(bytes[i], 8);

  // 终止符：最多 4 个 0
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(totalData);
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
    out[i / 8] = value;
  }
  // 交替填充字节 0xEC / 0x11
  for (let i = bits.length / 8, k = 0; i < totalData; i++, k++) {
    out[i] = k % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/** 分块 + RS 纠错 + 交织，得到最终码字序列 */
function interleaveBlocks(dataCodewords, version) {
  const [ecLen, b1, d1, b2, d2] = BLOCKS_M[version];
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < b1; i++) {
    blocks.push(dataCodewords.slice(pos, pos + d1));
    pos += d1;
  }
  for (let i = 0; i < b2; i++) {
    blocks.push(dataCodewords.slice(pos, pos + d2));
    pos += d2;
  }
  const ecBlocks = blocks.map((block) => rsEncode(block, ecLen));

  const maxDataLen = Math.max(...blocks.map((b) => b.length));
  const out = [];
  for (let i = 0; i < maxDataLen; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]);
  }
  for (let i = 0; i < ecLen; i++) {
    for (const block of ecBlocks) out.push(block[i]);
  }
  return Uint8Array.from(out);
}

/* ------------------------------------------------------------------ */
/* 矩阵构建                                                            */
/* ------------------------------------------------------------------ */

function emptyGrid(size, fill) {
  const rows = [];
  for (let r = 0; r < size; r++) rows.push(new Uint8Array(size).fill(fill));
  return rows;
}

function cloneGrid(grid) {
  return grid.map((row) => Uint8Array.from(row));
}

function placeFinder(matrix, reserved, top, left) {
  const size = matrix.length;
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = top + r;
      const col = left + c;
      if (row < 0 || row >= size || col < 0 || col >= size) continue;
      const inRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const inRingV = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      matrix[row][col] = inRing || inRingV || inCore ? 1 : 0;
      reserved[row][col] = 1;
    }
  }
}

function placeAlignment(matrix, reserved, centerRow, centerCol) {
  for (let r = -2; r <= 2; r++) {
    for (let c = -2; c <= 2; c++) {
      const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
      matrix[centerRow + r][centerCol + c] = dark ? 1 : 0;
      reserved[centerRow + r][centerCol + c] = 1;
    }
  }
}

function overlapsFinder(center, size) {
  return (
    (center[0] === 6 && center[1] === 6) ||
    (center[0] === 6 && center[1] === size - 7) ||
    (center[0] === size - 7 && center[1] === 6)
  );
}

/** 画出所有功能图形，返回 [matrix, reserved] */
function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const matrix = emptyGrid(size, 0);
  const reserved = emptyGrid(size, 0);

  placeFinder(matrix, reserved, 0, 0);
  placeFinder(matrix, reserved, 0, size - 7);
  placeFinder(matrix, reserved, size - 7, 0);

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0 ? 1 : 0;
    matrix[6][i] = dark;
    reserved[6][i] = 1;
    matrix[i][6] = dark;
    reserved[i][6] = 1;
  }

  // 校正图形
  const centers = ALIGN_M[version];
  for (const rowCenter of centers) {
    for (const colCenter of centers) {
      if (overlapsFinder([rowCenter, colCenter], size)) continue;
      placeAlignment(matrix, reserved, rowCenter, colCenter);
    }
  }

  // 固定黑点
  matrix[size - 8][8] = 1;
  reserved[size - 8][8] = 1;

  // 预留格式信息区
  for (let i = 0; i <= 8; i++) {
    reserved[8][i] = 1;
    reserved[i][8] = 1;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = 1;
    reserved[size - 1 - i][8] = 1;
  }

  // 预留版本信息区（版本 >= 7）
  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        reserved[i][size - 11 + j] = 1;
        reserved[size - 11 + j][i] = 1;
      }
    }
  }

  return [matrix, reserved];
}

/** 按标准 ZigZag 顺序写入码字，returns 实际写入的模块数 */
function placeCodewords(matrix, reserved, codewords) {
  const size = matrix.length;
  const totalBits = codewords.length * 8;
  let bitIndex = 0;
  let written = 0;
  let upward = true;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // 跳过定时列
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        let bit = 0;
        if (bitIndex < totalBits) {
          bit = (codewords[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1;
        }
        bitIndex++;
        matrix[row][c] = bit;
        written++;
      }
    }
    upward = !upward;
  }
  return written;
}

function maskCondition(pattern, row, col) {
  switch (pattern) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return (((row * col) % 2) + ((row * col) % 3)) === 0;
    case 6:
      return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
    default:
      return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
  }
}

function applyMask(matrix, reserved, pattern) {
  const size = matrix.length;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!reserved[row][col] && maskCondition(pattern, row, col)) {
        matrix[row][col] ^= 1;
      }
    }
  }
}

/** 格式信息：BCH(15,5) + 固定掩码 0x5412 */
function formatBits(ecBits, mask) {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** 版本信息：BCH(18,6)（版本 >= 7 才需要） */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | rem;
}

const getBit = (value, index) => (value >>> index) & 1;

function drawFormatBits(matrix, version, mask) {
  const size = matrix.length;
  const bits = formatBits(EC_LEVEL_M, mask);

  for (let i = 0; i <= 5; i++) matrix[i][8] = getBit(bits, i);
  matrix[7][8] = getBit(bits, 6);
  matrix[8][8] = getBit(bits, 7);
  matrix[8][7] = getBit(bits, 8);
  for (let i = 9; i < 15; i++) matrix[8][14 - i] = getBit(bits, i);

  for (let i = 0; i < 8; i++) matrix[8][size - 1 - i] = getBit(bits, i);
  for (let i = 8; i < 15; i++) matrix[size - 15 + i][8] = getBit(bits, i);
  matrix[size - 8][8] = 1; // 固定黑点
}

function drawVersionBits(matrix, version) {
  if (version < 7) return;
  const size = matrix.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix[b][a] = bit;
    matrix[a][b] = bit;
  }
}

/* ------------------------------------------------------------------ */
/* 掩码罚分                                                            */
/* ------------------------------------------------------------------ */

const PATTERN_A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
const PATTERN_B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];

function penaltyScore(matrix) {
  const size = matrix.length;
  let score = 0;

  // 规则 1：同色连续 5 个以上
  for (let i = 0; i < size; i++) {
    let runRow = 1;
    let runCol = 1;
    for (let j = 1; j < size; j++) {
      if (matrix[i][j] === matrix[i][j - 1]) runRow++;
      else {
        if (runRow >= 5) score += 3 + (runRow - 5);
        runRow = 1;
      }
      if (matrix[j][i] === matrix[j - 1][i]) runCol++;
      else {
        if (runCol >= 5) score += 3 + (runCol - 5);
        runCol = 1;
      }
    }
    if (runRow >= 5) score += 3 + (runRow - 5);
    if (runCol >= 5) score += 3 + (runCol - 5);
  }

  // 规则 2：2x2 同色方块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const v = matrix[row][col];
      if (
        v === matrix[row][col + 1] &&
        v === matrix[row + 1][col] &&
        v === matrix[row + 1][col + 1]
      ) {
        score += 3;
      }
    }
  }

  // 规则 3：形似定位图形的 1:1:3:1:1 序列
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      let a = true;
      let b = true;
      let c = true;
      let d = true;
      for (let k = 0; k < 11; k++) {
        const rowBit = matrix[i][j + k];
        const colBit = matrix[j + k][i];
        if (rowBit !== PATTERN_A[k]) a = false;
        if (rowBit !== PATTERN_B[k]) b = false;
        if (colBit !== PATTERN_A[k]) c = false;
        if (colBit !== PATTERN_B[k]) d = false;
      }
      if (a) score += 40;
      if (b) score += 40;
      if (c) score += 40;
      if (d) score += 40;
    }
  }

  // 规则 4：黑模块占比偏离 50%
  let dark = 0;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) dark += matrix[row][col];
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把文本编码成二维码矩阵。
 * @param {string} text
 * @returns {{version:number,size:number,mask:number,matrix:Uint8Array[]}}
 */
function encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  const version = pickVersion(bytes.length);
  if (!version) {
    throw new Error(
      `内容过长：当前 ${bytes.length} 字节，最大 ${byteCapacity(MAX_VERSION)} 字节。` +
        '换一个更短的域名或更短的编号即可。'
    );
  }

  const dataCodewords = buildDataCodewords(bytes, version);
  const codewords = interleaveBlocks(dataCodewords, version);
  const [baseMatrix, reserved] = buildFunctionPatterns(version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const matrix = cloneGrid(baseMatrix);
    placeCodewords(matrix, reserved, codewords);
    applyMask(matrix, reserved, mask);
    drawFormatBits(matrix, version, mask);
    drawVersionBits(matrix, version);
    const score = penaltyScore(matrix);
    if (!best || score < best.score) best = { score, matrix, mask };
  }

  return {
    version,
    size: version * 4 + 17,
    mask: best.mask,
    matrix: best.matrix,
  };
}

/**
 * 输出 SVG 字符串（矢量，打印不糊）。
 *
 * 默认是**圆形二维码**：
 *   - 数据点画成圆点
 *   - 三个定位图形画成同心圆（◎）—— 视觉上是圆的，但沿任意半径方向
 *     仍然是 1:1:3:1:1 的明暗比，扫码器照样认得出
 *   - 整体套在一个圆形白盘里
 *
 * 画布放大到「含静默区的正方形内接于圆」：如果直接把圆内切在二维码上，
 * 圆的四角会切掉角上的定位图形，扫码直接失效（这点是构造时就避开的，不是猜的）。
 *
 * @param {string} text
 * @param {{scale?:number, quiet?:number, dark?:string, light?:string, round?:boolean}} [options]
 */
function toSvg(text, options = {}) {
  const code = encode(text);
  const scale = options.scale || 8;
  const quiet = options.quiet === undefined ? 4 : options.quiet;
  const dark = options.dark || '#000000';
  const light = options.light || '#ffffff';
  const round = options.round !== false;

  const size = code.size;
  const padSize = size + quiet * 2;

  // 圆形模式下画布边长 = 内接正方形的对角线，这样四角都不会被切掉
  const box = round ? padSize * Math.SQRT2 : padSize;
  const dimension = Math.round(box * scale);
  const offset = round ? ((box - padSize) / 2) * scale : 0;
  const center = dimension / 2;

  const at = (row, col) => ({
    x: offset + (col + quiet) * scale,
    y: offset + (row + quiet) * scale,
  });

  // 三个定位图形（7×7）的左上角坐标
  const finders = [[0, 0], [0, size - 7], [size - 7, 0]];
  const inFinder = (row, col) =>
    finders.some(([r0, c0]) => row >= r0 && row < r0 + 7 && col >= c0 && col < c0 + 7);

  // 圆点半径 = 0.55 个格子（相邻圆点微叠）。这个值是解码实测出来的：
  //   0.45（留缝）→ 通过 12/36；0.50（相切）→ 36/36 但真实输出上偶发失败；
  //   0.55（微叠）→ 36/36，且模块四角被覆盖、墨迹连续。
  const radius = scale * 0.55;

  let dots = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!code.matrix[row][col] || inFinder(row, col)) continue;
      const { x, y } = at(row, col);
      dots += `<circle cx="${x + scale / 2}" cy="${y + scale / 2}" r="${radius}"/>`;
    }
  }

  // 定位图形：外环（黑）→ 中环（白）→ 中心（黑），三层同心圆
  let finderOuter = '';
  let finderRing = '';
  let finderCore = '';
  for (const [r0, c0] of finders) {
    const { x, y } = at(r0, c0);
    const cx = x + 3.5 * scale;
    const cy = y + 3.5 * scale;
    finderOuter += `<circle cx="${cx}" cy="${cy}" r="${3.5 * scale}"/>`;
    finderRing += `<circle cx="${cx}" cy="${cy}" r="${2.5 * scale}"/>`;
    finderCore += `<circle cx="${cx}" cy="${cy}" r="${1.5 * scale}"/>`;
  }

  const background = round
    ? `<circle cx="${center}" cy="${center}" r="${center}" fill="${light}"/>`
    : `<rect width="${dimension}" height="${dimension}" fill="${light}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dimension}" height="${dimension}" ` +
    `viewBox="0 0 ${dimension} ${dimension}" role="img">` +
    background +
    `<g fill="${dark}">${dots}${finderOuter}</g>` +
    `<g fill="${light}">${finderRing}</g>` +
    `<g fill="${dark}">${finderCore}</g>` +
    `</svg>`
  );
}

/** 终端里直接显示的字符画，用来肉眼/手机验证编码结果 */
function toAscii(text, options = {}) {
  const code = encode(text);
  const quiet = options.quiet === undefined ? 2 : options.quiet;
  const DARK = '\u2588\u2588';
  const LIGHT = '  ';
  const rows = [];
  const blank = LIGHT.repeat(code.size + quiet * 2);

  for (let i = 0; i < quiet; i++) rows.push(blank);
  for (let row = 0; row < code.size; row++) {
    let line = LIGHT.repeat(quiet);
    for (let col = 0; col < code.size; col++) {
      line += code.matrix[row][col] ? DARK : LIGHT;
    }
    rows.push(line + LIGHT.repeat(quiet));
  }
  for (let i = 0; i < quiet; i++) rows.push(blank);
  return rows.join('\n');
}

module.exports = {
  encode,
  toSvg,
  toAscii,
  byteCapacity,
  formatBits,
  versionBits,
  gfMul,
  rsEncode,
  MAX_VERSION,
  EC_LEVEL_M,
};
