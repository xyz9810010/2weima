# 挪车二维码

挡风玻璃上贴一张二维码：别人扫到后，点一下就能**一键拨号**联系车主。

同一套代码，两个运行目标：

| | Cloudflare Workers | Node.js |
|---|---|---|
| 数据 | D1（`src/d1.js`） | `node:sqlite`（`src/db.js`） |
| 入口 | `src/worker.js` | `src/server.js` |
| 依赖 | 无（不需要 `nodejs_compat`） | 无（Node 内置模块） |
| 适合 | 正式对外部署 | 本地跑、内网、自建服务器 |

路由、页面模板、二维码编码器全部共享（`src/app.js`、`src/views.js`、`src/qr.js`），
所以两个目标的行为一定一致，改一处两边都生效。

---

## 一、部署到 Cloudflare Workers

需要 Node ≥ 22.13（只为跑 wrangler，Worker 运行时本身不依赖 Node）。Wrangler 用 `npx` 拉取，项目依然零依赖。

```bash
# 1. 建 D1 数据库，把输出的 database_id 粘到 wrangler.toml 的 [[d1_databases]] 里
npx wrangler d1 create chezai-qrcode

# 2. 建表（远程）
npx wrangler d1 execute chezai-qrcode --remote --file=./schema.sql

# 3. 设置两个密钥
npx wrangler secret put ADMIN_PASSWORD     # 后台登录密码
npx wrangler secret put SESSION_SECRET     # 随便一串长随机字符串

# 4. 部署
npx wrangler deploy
```

部署完会得到 `https://chezai-qrcode.<你的账号>.workers.dev`。

**第 5 步（重要）**：把这个域名填进 `wrangler.toml` 的 `PUBLIC_BASE_URL`，再 `npx wrangler deploy` 一次。

```toml
[vars]
PUBLIC_BASE_URL = "https://chezai-qrcode.<你的账号>.workers.dev"
```

不填也能用，但二维码会按访问时的 Host 动态生成——**以后换了域名，已经打印出去的贴纸全部失效**。
建议顺便绑一个自己的域名（Workers 支持自定义域，自带 HTTPS）。

然后打开 `https://<你的域名>/admin`，用 `ADMIN_PASSWORD` 登录，点「新增车辆」。

### Workers 上的几个细节

- **管理密码不存在数据库里**。Node 版会把密码 hash 后存库；Worker 版直接比对平台 secret，
  因为 secret 本来就不落库，没有可离线爆破的哈希。防的是在线猜测，由登录限流负责
  （同一 IP 10 分钟 10 次）。这也是为什么 Worker 版不需要 PBKDF2 —— 顺带避开了免费计划
  那 10ms CPU 限额的坑。
- **静态资源**（`public/`）由 Cloudflare 边缘托管，配置在 `wrangler.toml` 的 `[assets]`。
  显式给了 `binding = "ASSETS"`，Worker 先跑、未命中路由再转交，行为不依赖平台默认值。
- **会话密钥**没配 `SESSION_SECRET` 时会自动生成并存进 D1 的 `settings` 表。
  多实例部署请务必显式配置，别依赖自动生成。
- **限流**：拨号打点按 `messages` 表统计，登录按 `rate_limits` 表。
  D1 没有跨语句事务，所以登录限流是「读-写」两步，理论上并发时能多放过去几次——
  对这个场景可以接受（密码本身是高熵 secret，不是靠限流兜底）。

### 部署后打不开？先看这三条

部署完发现「调用次数 0、页面打不开」，按顺序排这三件事，能覆盖绝大多数情况：

1. **没有任何 URL** —— Cloudflare 上新建的 Worker，`workers.dev` 路由默认可能是关的。
   Worker → 设置 → 域和路由 → 启用 `workers.dev`（或者绑一个自定义域名）。
   入口没开的话，访问量永远是 0，也不会有任何日志。
2. **`database_id` 还是占位字符串** —— 打开 `/` 或 `/admin` 直接 500，多半是这个。
   注意 `wrangler deploy --dry-run` **不会**因此报错（它只做本地打包），
   所以「部署成功但一访问就报错」比「部署失败」更常见。先 `wrangler d1 create` 再部署。
3. **没设 `ADMIN_PASSWORD` secret** —— 后台登录页会明确提示「尚未配置管理密码」。
   设完 secret 需要重新部署一次才会生效。

另外建议顺手把 Observability 里的 **Workers Logs 打开**（默认可能是禁用的），
否则线上出问题只能靠猜；打开后用 `npx wrangler tail` 或面板都能看到真实的报错。

### 本地开发 Worker

```bash
cp .dev.vars.example .dev.vars    # 填 ADMIN_PASSWORD
npm run db:local                  # 建本地 D1 表
npm run worker:dev                # http://localhost:8787
```

---

## 二、本地跑 Node 版

```bash
cp .env.example .env      # Windows: copy .env.example .env
npm start                 # 零依赖，不需要 npm install
```

首次启动会在日志里打印自动生成的管理密码：

```
  挪车二维码服务已启动（Node 版）
  车主后台：http://localhost:3000/admin
=========================================================
  首次启动，已生成车主后台管理密码：
      3f9a1c07b2e4d856
=========================================================
```

---

## 三、自检与端到端测试

两个脚本都是零依赖、不联网的：

```bash
npm test        # 二维码编码器自检（快，纯计算）
npm run e2e     # 端到端：真的起服务，跑完整个流程（约 3 秒）
npm run verify  # 上面两个一起跑
```

**`npm test`** 做三类**有真实判据**的检查：

1. **对齐规范常量** — 纠错等级 M 在版本 1–10 的 byte 容量表、8 个格式信息串（ISO/IEC 18004 Table C.1）、版本信息串（Table D.1）
2. **Reed-Solomon 数学性质** — 生成码字代入 α⁰…α^(t-1) 的伴随式必须全为 0（解码器第一步就是这个）
3. **矩阵结构** — 尺寸、三个定位图形、定时图形、固定黑点，以及两份格式信息互相一致且等于按掩码算出的值

最后打印一个真实二维码的**字符画**，直接拿手机扫一下即可确认。

**`npm run e2e`** 在临时端口上拉起 Node 版服务（用临时数据目录，不碰 `data/`），
走完「登录 → 建车 → 扫码 → 一键拨号 → 后台看记录 → 停用 → 已读 → 删除」，
共 50 项断言，跑完自动关服务、清临时目录。其中几条是**安全与回归不变量**，改代码时最该盯住：

- 扫码页**绝不能**出现车主真实手机号（有独立拨号号码时）
- **没填「拨号号码」但填了手机号时，扫码页必须仍然有拨号按钮**（否则贴纸等于废纸）
- 两个号码都没填时，不能出现 `tel:` 按钮
- 会话 Cookie 必须是 HttpOnly，且 http 下不能带 Secure（否则本地直接登不进去）
- 未登录的写操作必须被拒

---

## 四、代码结构

```
src/core.js      共享：纯函数 + WebCrypto（随机、HMAC 签名 Cookie、时间、转义）—— 无任何 node: 依赖
src/qr.js        共享：二维码编码器（byte 模式 / 纠错 M / 版本 1-10）→ SVG
src/views.js     共享：所有页面模板
src/app.js       共享：路由 + 业务逻辑，输入请求描述、输出 { status, headers, body }
src/db.js        Node：node:sqlite 实现 store 接口
src/util.js      Node：读请求体、scrypt 口令、转发头
src/server.js    Node：http 适配 + 启动
src/d1.js        Workers：D1 实现 store 接口
src/worker.js    Workers：fetch 适配
schema.sql       两边共用的一份建表 SQL（纯 DDL，无 PRAGMA）
public/          style.css / app.js，两个平台各自托管
scripts/         start.js（Node 启动）、selftest.js（编码器自检）、e2e.js（端到端）
```

分层的关键是两道接缝：

- **请求/响应是普通对象**。`src/app.js` 只认识 `{method, pathname, url, cookie, ip, userAgent, origin, readText}`，
  返回 `{status, headers, body}`。Node 适配层把它变成 `http.ServerResponse`，Worker 适配层变成 `Response`。
- **store 是纯异步接口**。`getCar / addMessage / countRecentByIp / bumpRateLimit …` 两边签名一致，
  所以共享层 `await` 谁都不知道自己跑在哪。

Node 的 `node:sqlite` 其实是同步的，这里刻意包成 async —— 为了和 D1 对齐，代价是零。

---

## 五、隐私设计

扫码页上只有一个「一键拨号」按钮，**不提供留言**，页面本身不展示任何号码（号码只在 `tel:` 链接里）。

| 数据 | 存放位置 | 是否返回给扫码人 |
| --- | --- | --- |
| 拨号号码 `call_number` | 数据库 | 只出现在 `tel:` 链接里。设计上填隐私号 / 虚拟号 |
| 真实手机号 `phone` | 数据库 | 平时不返回。**但拨号号码留空时会退化成拨打它**（见下） |
| 扫码人 IP、UA | 数据库 | 不返回，只记录「有人点了一次拨号」 |
| 通话内容、拨出号码 | 不采集 | —— |

**关于两个号码的关系**（这一点容易被误解）：

- 填了「拨号号码」→ 扫码人拨打它，真实手机号不出现在页面里。想藏号就用隐私号服务。
- 没填「拨号号码」但填了「真实手机号」→ 扫码页拨打真实手机号（**等于公开它**）。
  没有隐私号服务、只想让人打给自己，就属于这种情况，按需选择。
- 两个都留空 → 扫码页没有按钮，贴纸等于没用。

其他措施：

- 车辆编号是 10 位随机码（去掉易混字符的 58 字符表，且做了拒绝采样避免取模偏差），不可枚举；后台可随时停用某个码
- 后台只记录「有人点了一次拨号」，**不记录通话内容，也不记录拨出号码**
- 拨号打点限流：同一 IP 10 分钟最多 30 次（只影响记录写入，不影响用户能不能拨出去）
- 会话是 HMAC-SHA256 签名的 HttpOnly Cookie，`SameSite=Lax`（跨站 POST 不带 Cookie，等于自带 CSRF 防护），12 小时过期
- 全站 CSP `default-src 'none'`，所有输出经过 HTML 转义

---

## 六、接真实隐私号（AXB 虚拟号）

当前实现对拨号部分做了**刻意的占位**：扫码页上的号码直接取自车辆资料里的「拨号号码」。
你去阿里云 / 腾讯云 / 运营商开通隐私号后把号码填进去即可，无需改代码。

要做到「每个扫码人生成一次性号码、通话自动过期」，改动点只有两处：

1. `src/app.js` 的 `handleScan`：把 `dialNumberOf(car)` 换成调用服务商 API 动态申请的号码
2. `POST /c/:code/call`：拨号前先申请号码，再返回给前端跳转 `tel:`

两个平台共用这份逻辑，所以只改一遍。数据层不用动。

---

## 七、已知边界

- **`*.workers.dev` 在中国大陆打不开**（这是本项目最需要注意的一条）。实测：域名被 DNS 污染，
  且 TLS 握手阶段就会被重置（SNI 阻断），换任何 DNS 都没用。如果扫码的人和车主在中国大陆，
  **必须给 Worker 绑一个自己的域名**（自定义域名的 SNI 不在拦截名单里，Cloudflare 的 IP 本身是通的），
  或者干脆用 Node 版部署在国内服务器上。仅靠 `workers.dev` 的部署只适合境外用户
- **URL 上限 213 字节**（版本 10 / 纠错 M）。域名太长或带一堆参数就会超，超了在生成二维码时明确报错，不会静默截断
- **拨号是 `tel:` 跳转**，扫码人手机上是否弹拨号盘取决于系统与浏览器（微信内置一般能唤起；被拦截时可长按复制号码，但页面本身不展示号码，所以更稳的做法是提示用户用系统相机扫码）
- **D1 没有跨语句事务**，登录限流是读-写两步（见上文）
- **Workers 免费计划的 CPU 限额较低**。这里每个请求只做几次 D1 查询加一次二维码矩阵运算，
  并且二维码结果按「域名+编号」缓存在 isolate 内，正常规模没问题；车辆特别多（后台一页几十张二维码）时才需要留意
- **单租户**。一个部署 = 一个车主后台。要做成 SaaS 多租户得再加账号体系与行级隔离

## 八、待办

- [ ] 接入隐私号服务商，实现动态小号与通话记录回调
- [ ] 车主端接微信订阅消息 / 短信，有人拨号就推送，不用一直刷后台
- [ ] 贴纸导出 PDF（当前是打印页 + 另存为 PDF）
- [ ] 多租户：一个部署服务多个车主

## 许可

MIT
