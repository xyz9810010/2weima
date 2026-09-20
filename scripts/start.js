'use strict';

/**
 * 启动入口：先把 .env 读进 process.env，再拉起服务。
 *
 * 自己解析而不是用 node --env-file，是为了不依赖具体 Node 小版本的命令行参数。
 * 只支持 KEY=VALUE、# 注释、可选引号；已经存在的环境变量优先（不会被 .env 覆盖）。
 */

const fs = require('node:fs');
const path = require('node:path');

const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator < 1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted && value.length >= 2) value = value.slice(1, -1);

    if (process.env[key] === undefined) process.env[key] = value;
  }
}

require('../src/server');
