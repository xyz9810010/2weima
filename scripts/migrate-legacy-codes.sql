-- 把「车辆编号」补成贴纸编号行（幂等，可重复执行）。
--
-- 为什么需要它：贴纸编号是后加的概念，早期版本的码就是车辆编号本身。
-- 跑一遍这个迁移，历史车辆在「贴纸编号」列表里才看得见。
--
-- 但**不跑也不影响扫码** —— src/app.js 的 resolveCode() 在编号表查不到时会回落
-- 到按车辆编号查，所以已经印出去的贴纸永远有效。这个迁移只是为了后台列表完整。
--
-- Node 版（src/db.js）启动时自动执行同一句。
-- Workers / D1 手动执行一次：
--   npx wrangler d1 execute chezai-qrcode --remote --file=./scripts/migrate-legacy-codes.sql

INSERT OR IGNORE INTO codes (code, car_id, owner_id, note, created_at, bound_at)
SELECT id, id, owner_id, '', created_at, created_at FROM cars;
