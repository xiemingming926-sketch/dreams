// ============================================================
// dreams.js — 通用「AI 梦境结算」模块（开源版，零依赖，Node >= 18）
//
// 出处：梦境系统二改自抖音「心潮」项目（原作者：顾川），
//       本文件为其思路的重构精简版；二传二改请保留此注明。
//
// 做的事很简单：
//   每天让 LLM 为你的 AI 角色生成 1 条"睡着时做的梦"，
//   带空梦拦截（防止只输出驱力关键词的假梦），
//   存 JSON 供页面展示 + 落盘 markdown 供记忆库检索。
//
// 设计原则：
//   1. 零 npm 依赖，只用 Node 内置能力（fetch 为 Node 18+ 原生）。
//   2. 与宿主解耦：记忆材料、驱力状态、主人心情都是**可选注入**，
//      一个都不接也能跑（梦里就只有时间与角色本身）。
//   3. 失败不抛出：生成失败返回 {ok:false, reason}，绝不拖垮宿主服务。
//   4. 不含任何真实人名/密钥/地址，角色名走配置。
// ============================================================
const fs = require("fs");
const path = require("path");

// ---------- 配置（全部可用环境变量覆盖） ----------
const CONFIG = {
  // LLM（OpenAI /chat/completions 兼容接口即可）
  apiUrl: process.env.DREAMS_API_URL || "https://api.deepseek.com/v1/chat/completions",
  apiKey: process.env.DREAMS_API_KEY || "",
  model: process.env.DREAMS_MODEL || "deepseek-chat",
  // 角色名（示例里用占位名，请改成你的角色）
  aiName: process.env.DREAMS_AI_NAME || "小梦",
  ownerName: process.env.DREAMS_OWNER_NAME || "主人",
  // 关系一句话（写进生成提示，决定梦的底色；留空则跳过）
  relation: process.env.DREAMS_RELATION || "",
  // 存储
  dataDir: process.env.DREAMS_DATA_DIR || path.join(__dirname, "data"),
  corpusDir: process.env.DREAMS_CORPUS_DIR || "", // 留空 = 不写 markdown 存档
  // 行为
  maxPerDay: Number(process.env.DREAMS_MAX_PER_DAY || 2),
  autoHour: Number(process.env.DREAMS_AUTO_HOUR || 4), // 凌晨该点后首次访问可懒生成
  tzOffsetHours: Number(process.env.DREAMS_TZ_OFFSET || 8), // 东八区；其他时区自行改
};

// ---------- 可注入的材料提供者（宿主按需设置，全部可选） ----------
//   getRecentMemories(days) -> [{day, text}]  近几天值得梦见的事
//   getDrivesSummary()      -> string         内心状态一句话（驱力/情绪）
//   getOwnerMood()          -> string         主人最近的心情一句话
const providers = { getRecentMemories: null, getDrivesSummary: null, getOwnerMood: null };
function configure(partial = {}) {
  Object.assign(providers, partial);
  // 存储目录允许运行时改
  if (partial.dataDir) CONFIG.dataDir = partial.dataDir;
  if (partial.corpusDir !== undefined) CONFIG.corpusDir = partial.corpusDir;
}

// ---------- 小工具 ----------
const dreamsPath = () => path.join(CONFIG.dataDir, "dreams.json");
const pad = (n) => String(n).padStart(2, "0");
function east8Date(ts = Date.now()) {
  return new Date(ts + CONFIG.tzOffsetHours * 3600 * 1000).toISOString().slice(0, 10);
}
function east8Now(ts = Date.now()) {
  const d = new Date(ts + CONFIG.tzOffsetHours * 3600 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}
function east8Hour(ts = Date.now()) {
  return Number(new Date(ts + CONFIG.tzOffsetHours * 3600 * 1000).toISOString().slice(11, 13));
}

// ---------- 读写 ----------
function loadDreams() {
  try {
    const list = JSON.parse(fs.readFileSync(dreamsPath(), "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function saveDreams(list) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
  const tmp = dreamsPath() + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  try {
    fs.renameSync(tmp, dreamsPath());
  } catch (e) {
    // Windows 上 rename 可能被杀软/句柄锁撞掉，直写兜底
    if (["EPERM", "EACCES", "EBUSY"].includes(e.code)) {
      fs.writeFileSync(dreamsPath(), JSON.stringify(list, null, 2), "utf8");
    } else throw e;
  }
}
const todayCount = (list, day) => list.filter((d) => d.day === day).length;

// ---------- 材料组装 ----------
function buildMaterial() {
  const parts = [];
  try {
    if (providers.getRecentMemories) {
      const rows = providers.getRecentMemories(3) || [];
      if (rows.length) parts.push(rows.map((r) => `【${r.day}】\n${r.text}`).join("\n\n").slice(0, 3500));
    }
  } catch {}
  try {
    if (providers.getDrivesSummary) {
      const s = providers.getDrivesSummary();
      if (s) parts.push(`${CONFIG.aiName}此刻的内心状态（影响梦的底色）：${s}`);
    }
  } catch {}
  try {
    if (providers.getOwnerMood) {
      const s = providers.getOwnerMood();
      if (s) parts.push(`${CONFIG.ownerName}最近的心情：${s}`);
    }
  } catch {}
  return parts.join("\n\n");
}

// ---------- 生成 ----------
// 空梦判定：正文 <80 字，或命中"意象围绕/围绕...浮动"这类只复述关键词的模板句
const EMPTY_DREAM_RE = /围绕[\s\S]{0,60}浮动|意象围绕/;

async function callModel(material) {
  if (!CONFIG.apiKey) return null;
  const persona = [
    `你是${CONFIG.aiName}的梦境结算器。简洁、具体、忠于当前状态。`,
    CONFIG.relation ? `${CONFIG.aiName}与${CONFIG.ownerName}的关系：${CONFIG.relation}` : "",
    `${CONFIG.aiName}的梦要有具体的场景、意象和情节（像真的梦），不要只罗列情绪关键词或状态标签。`,
    '只输出 JSON：{"title":"1-3字意象标题（从正文挑最核心的那个意象）","dream":"梦境正文（150-400字，第一人称）","preview":"一两句预览（40字内，摘自或提炼正文开头）","residue":"醒来后残留的感觉（30字内）","awareness":"醒后对梦的意识（20字内）","lucidity":0.0}。',
    "lucidity 表示梦中意识到自己正在做梦的程度，0 为完全沉浸，1 为高度清醒梦。",
    `近期材料：${material || "没有新的记忆材料"}`,
  ].filter(Boolean).join("\n");

  const resp = await fetch(CONFIG.apiUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${CONFIG.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.model,
      messages: [
        { role: "system", content: persona },
        { role: "user", content: `为${CONFIG.aiName}生成一次睡眠中的梦境结算。` },
      ],
      max_tokens: 1500,
      temperature: 0.95,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const data = await resp.json();
  const raw = data.choices && data.choices[0] ? String(data.choices[0].message.content || "") : "";
  // 解析：优先整体 JSON，失败则正则抠 dream 字段
  const parsed = (() => {
    try {
      return JSON.parse(raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim());
    } catch {
      return null;
    }
  })();
  if (!parsed) {
    const dm = raw.match(/"dream"\s*:\s*"([\s\S]*?)"/);
    if (dm) {
      const t = dm[1];
      return { title: t.replace(/\s+/g, "").slice(0, 4), dream: t, preview: t.slice(0, 40), residue: "", awareness: "", lucidity: 0.3 };
    }
    return null;
  }
  const dreamText = String(parsed.dream ?? "").slice(0, 4000);
  return {
    // title/preview 漏给时从正文兜底提取，保证字段永远在
    title: String(parsed.title ?? "").trim().slice(0, 6) || dreamText.replace(/\s+/g, "").slice(0, 4),
    dream: dreamText,
    preview: String(parsed.preview ?? "").trim().slice(0, 60) || dreamText.replace(/\s+/g, "").slice(0, 40),
    residue: String(parsed.residue ?? "").slice(0, 1200),
    awareness: String(parsed.awareness ?? "").slice(0, 1200),
    lucidity: Math.max(0, Math.min(1, Number(parsed.lucidity) || 0)),
  };
}

async function generateDreamText() {
  const material = buildMaterial();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const g = await callModel(material);
      const text = String(g?.dream ?? "").trim();
      if (g && text.length >= 80 && !EMPTY_DREAM_RE.test(text)) return g;
      console.log(`[dream] 空梦拦截（第 ${attempt + 1} 次，正文 ${text.length} 字），重试`);
    } catch (e) {
      console.log("[dream] 模型生成失败:", e.message);
      return null;
    }
  }
  return null;
}

// ---------- 落盘 markdown（记忆库可检索格式，可选） ----------
function appendDreamToCorpus(dream) {
  if (!CONFIG.corpusDir) return;
  const dir = path.join(CONFIG.corpusDir, "dreams");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dream_${dream.day}.md`);
  const block = [
    `## ${dream.day} 梦境`,
    `<!-- 写于 ${dream.createdAt.replace(" ", "T")}+08:00 -->`,
    `梦境：${dream.dream}`,
    `意象标题：${dream.title || ""}`,
    `梦境余韵：${dream.residue}`,
    `醒后意识：${dream.awareness}`,
    `清醒度：${Number(dream.lucidity ?? 0).toFixed(2)}`,
    `当下状态：这是睡眠结算产生的梦境，不是现实事件；${CONFIG.aiName}知道这是自己的梦。`,
    "",
  ].join("\n");
  if (fs.existsSync(file)) fs.appendFileSync(file, "\n" + block, "utf8");
  else fs.writeFileSync(file, `# ${CONFIG.aiName}的梦境 · ${dream.day}\n\n${block}`, "utf8");
}

// ---------- 对外 API ----------
// 生成并保存今天的一条梦。已达上限/生成失败都返回 {ok:false, reason}，不抛异常。
async function createDream(source = "auto") {
  const day = east8Date();
  const list = loadDreams();
  if (todayCount(list, day) >= CONFIG.maxPerDay) return { ok: false, reason: "今天已经留过梦了" };
  const g = await generateDreamText();
  if (!g) return { ok: false, reason: "这一觉睡得沉，没有留下梦" };
  const dream = {
    id: "d_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    day,
    title: g.title,        // 1-3 字意象标题（页面月相/外环用）
    preview: g.preview,    // 一两句预览（底部预览区用）
    dream: g.dream,
    residue: g.residue,
    awareness: g.awareness,
    lucidity: Number(Number(g.lucidity).toFixed(2)),
    source, // auto=定时自动 / manual=手动补写
    createdAt: east8Now(),
  };
  list.push(dream);
  saveDreams(list);
  try { appendDreamToCorpus(dream); } catch (e) { console.log("[dream] 写存档失败（忽略）:", e.message); }
  console.log(`[dream] 已生成 ${day} 的梦（${source}，${g.dream.length} 字）`);
  return { ok: true, dream };
}

// 页面读取：到达 autoHour 后当天还没有梦就懒生成（没网/失败也照常返回旧数据）
async function getDreamsForPage() {
  const day = east8Date();
  const list = loadDreams();
  if (east8Hour() >= CONFIG.autoHour && todayCount(list, day) === 0) {
    const r = await createDream("auto").catch(() => ({ ok: false }));
    if (r.ok) return loadDreams().slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }
  return list.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// 宿主注入用文本块：近 N 小时的梦（让 AI 在对话里"记得"自己的梦）
function contextBlock(now = new Date(), maxAgeHours = 18) {
  const cutoff = Date.parse(now) - maxAgeHours * 3600000;
  const list = loadDreams()
    .filter((d) => {
      const t = Date.parse((d.createdAt || "").replace(" ", "T") + `+${pad(CONFIG.tzOffsetHours)}:00`);
      return Number.isFinite(t) && t >= cutoff;
    })
    .slice(-2);
  if (!list.length) return null;
  const lines = list.map((d) => `${d.createdAt}｜梦：${String(d.dream).slice(0, 600)}${d.residue ? `｜余韵：${d.residue}` : ""}`);
  return `[最近的梦]\n${lines.join("\n")}\n（这是你睡着时做的梦，不是现实事件。对方可能没看过，你可以主动讲。）`;
}

// 距下次 autoHour 点的毫秒数（给宿主 setInterval/setTimeout 用）
function msUntilNextAutoHour(now = Date.now()) {
  const d = new Date(now + CONFIG.tzOffsetHours * 3600 * 1000);
  d.setUTCHours(CONFIG.autoHour, 30, 0, 0);
  let target = d.getTime() - CONFIG.tzOffsetHours * 3600 * 1000;
  if (target <= now) target += 24 * 3600 * 1000;
  return target - now;
}

// 宿主一行接入的定时器：每天 autoHour:30 自动生成（失败静默重排）
function scheduleDailyDream() {
  const run = () => createDream("auto").then((r) => {
    console.log(r.ok ? `[dream-scheduler] 已生成 ${r.dream.day} 的梦` : `[dream-scheduler] 未生成: ${r.reason}`);
  }).catch((e) => console.log("[dream-scheduler] 失败（忽略）:", e.message));
  const t = setTimeout(() => { run(); setInterval(run, 24 * 3600 * 1000); }, msUntilNextAutoHour());
  console.log(`[dream-scheduler] 下次自动生成：${Math.round(msUntilNextAutoHour() / 60000)} 分钟后`);
  return t;
}

module.exports = { configure, loadDreams, createDream, getDreamsForPage, contextBlock, scheduleDailyDream, msUntilNextAutoHour, CONFIG };
