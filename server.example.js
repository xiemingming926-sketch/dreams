// ============================================================
// server.example.js — 独立试运行示例（零依赖，Node >= 18）
//
// 出处：梦境系统二改自抖音「心潮」（原作者：顾川）；
//       月环日历美化页面为 Lydia 原创。二传二改请保留注明。
//
// 演示四件事：
//   1. 美化梦境页面：GET /            （public/dreams-page.html，月环日历）
//   2. 梦境页面接口：GET  /api/dreams （列表，凌晨后自动补今天的梦）
//   3. 手动补写：    POST /api/dreams/generate（受 basicAuth 保护）
//   4. 给 AI 注入用：GET /api/inject/dreams（返回可塞进 system 的文本块）
//
// 运行：
//   DREAMS_API_KEY=sk-xxx DREAMS_ADMIN_PASS=yourpass node server.example.js
// 然后浏览器开 http://127.0.0.1:3012/  看页面；接口走 /api/dreams
// ============================================================
const http = require("http");
const fs = require("fs");
const path = require("path");
const dreams = require("./dreams.js");

// ---- 可选：把你的记忆/状态接进梦的材料（不接也能跑） ----
dreams.configure({
  // getRecentMemories: (days) => [...],        // 返回 [{day, text}]
  // getDrivesSummary: () => "好奇 0.72（上升），难过 0.11（回落）",
  // getOwnerMood: () => "今天有点累，但心情不错",
});

const PORT = Number(process.env.DREAMS_PORT || 3012);
const ADMIN_USER = process.env.DREAMS_ADMIN_USER || "admin";
const ADMIN_PASS = process.env.DREAMS_ADMIN_PASS || "changeme";
const PUB = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".svg": "image/svg+xml", ".json": "application/json",
};

function authOk(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  try {
    const [u, p] = Buffer.from(h.slice(6), "base64").toString("utf8").split(":");
    return u === ADMIN_USER && p === ADMIN_PASS;
  } catch {
    return false;
  }
}
function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on("end", () => resolve(raw));
    req.on("error", () => resolve(""));
  });
}

// ---- 静态托管 public/（美化页面 + 素材） ----
function serveStatic(req, res, p) {
  if (req.method !== "GET" || p.startsWith("/api")) return false;
  const rel = p === "/" ? "/dreams-page.html" : p;
  const file = path.normalize(path.join(PUB, rel));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "Content-Type": (MIME[ext] || "application/octet-stream") + "; charset=utf-8" });
  res.end(fs.readFileSync(file));
  return true;
}

// 每天 autoHour:30 自动生成（先试跑一次结算定时器）
dreams.scheduleDailyDream();

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname;

  if (serveStatic(req, res, p)) return;

  if (p === "/api/dreams" && req.method === "GET") {
    // 示例服务里不加鉴权，让页面开箱即读；正式部署时建议按需加回 authOk(req)
    try {
      const list = await dreams.getDreamsForPage();
      sendJson(res, 200, { ok: true, dreams: list });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (p === "/api/dreams/generate" && req.method === "POST") {
    if (!authOk(req)) return sendJson(res, 401, { ok: false, error: "需要登录" });
    const r = await dreams.createDream("manual").catch((e) => ({ ok: false, reason: e.message }));
    sendJson(res, r.ok ? 200 : 400, r);
    return;
  }

  // 给宿主 AI 注入用（建议只暴露给本机，不加公网）
  if (p === "/api/inject/dreams" && req.method === "GET") {
    sendJson(res, 200, { ok: true, block: dreams.contextBlock() });
    return;
  }

  sendJson(res, 404, { ok: false, error: "没有这个端点" });
});

// POST /api/dreams/generate 允许空体，单独处理 body 解析
server.on("request", (req) => { if (req.method === "POST") readBody(req); });

server.listen(PORT, "0.0.0.0", () => {
  console.log(`dreams 示例服务: http://127.0.0.1:${PORT}（页面即此地址；管理账号 ${ADMIN_USER}）`);
});
