/**
 * 文字钓鱼 · 常驻能力层（tool 上下文）。
 *
 * 职责：
 *   1) 游戏主循环：scheduler 每 5 秒巡检钓鱼会话（抛竿即咬钩 → 超时跑鱼）
 *   2) 道具商城：购买增益道具，按稀有度档位提升中鱼概率（接下来 N 竿生效）
 *   3) 向宿主 Agent 注册 7 个工具（抛竿 / 收杆 / 状态 / 图鉴 / 收竿 / 商店列表 / 购买）
 *   4) 咬钩/中鱼时冒泡 + 播动作 + 刷徽标 + 广播事件
 *   5) 监听 panel/card 发来的 fishing:action 与 fishing:changed，保持联动
 *   6) 咬钩瞬间预抽稀有度（手感），SR/SSR 上鱼走宿主 ai.chat 生成专属台词
 *      （no-key / 限流时静默降级为预写台词）
 *   7) 每日任务板（惰性跨天刷新）+ 监听 todo-reminder:completed 给摸鱼佣金
 *   8) 每日经营圈（v0.5.0）：图鉴里程碑成就、连续签到、23:58 日报播报、
 *      每日鱼市行情（AI 编行情词）、open-meteo 真实天气影响鱼情（失败静默降级）
 *
 * 存档在插件私有 storage（data.json），tool / panel / card 三侧共用：
 *   save     = { coins, session, log[], dex{}, buffs[], stats{casts,catches,escapes,bestValue,earned,spent,today{}},
 *                quests{date, list[...]}, sign{last,streak}, market{date,fishId,name,icon,rarity,mult,line},
 *                weather{fetchedAt,code,desc,emoji,boost{}}, achievements{claimed[]} }
 *   catalog  = 100 种鱼的花名册（activate 时写入，panel/card 动态读取，单一数据源）
 *   shop     = 商店道具表（同上）
 */

'use strict';

const SAVE_KEY = 'save';
const CATALOG_KEY = 'catalog';
const SHOP_KEY = 'shop';
const CHANGED_EVENT = 'fishing:changed';
const BITE_EVENT = 'fishing:bite';
const ACTION_EVENT = 'fishing:action';   // panel/card → tool 的动作通道
const MAX_LOG = 100;

const TICK_MS = 5 * 1000;                 // 巡检粒度：5 秒（负责跑鱼判定）
const BITE_WINDOW_MS = 45 * 1000;         // 抛竿即咬钩，收杆窗口 45 秒
const BUBBLE_MS_BITE = 8 * 1000;
const BUBBLE_MS_CATCH = 6 * 1000;
const BUBBLE_MS_STORY = 10 * 1000;        // ai 台词停留更久

// ---------- 鱼种花名册（共 100 种：N40 / R30 / SR20 / SSR10）----------

const FISH_POOL = {
  N: [
    { id: 'n1',  name: '小鲫鱼',   icon: '🐟', value: 3 },
    { id: 'n2',  name: '小虾米',   icon: '🦐', value: 2 },
    { id: 'n3',  name: '泥鳅',     icon: '🐟', value: 2 },
    { id: 'n4',  name: '水草',     icon: '🌿', value: 1 },
    { id: 'n5',  name: '破靴子',   icon: '🥾', value: 1 },
    { id: 'n6',  name: '小银鱼',   icon: '🐟', value: 3 },
    { id: 'n7',  name: '田螺',     icon: '🐌', value: 2 },
    { id: 'n8',  name: '河蚌',     icon: '🦪', value: 3 },
    { id: 'n9',  name: '蝌蚪',     icon: '🐸', value: 2 },
    { id: 'n10', name: '小龙虾',   icon: '🦞', value: 5 },
    { id: 'n11', name: '青蛙',     icon: '🐸', value: 4 },
    { id: 'n12', name: '白条',     icon: '🐟', value: 3 },
    { id: 'n13', name: '麦穗鱼',   icon: '🐟', value: 2 },
    { id: 'n14', name: '溪石斑',   icon: '🐟', value: 4 },
    { id: 'n15', name: '黄颡鱼',   icon: '🐟', value: 5 },
    { id: 'n16', name: '水虿',     icon: '🐛', value: 2 },
    { id: 'n17', name: '空罐头',   icon: '🥫', value: 1 },
    { id: 'n18', name: '漂流瓶',   icon: '🍾', value: 2 },
    { id: 'n19', name: '烂渔网',   icon: '🕸', value: 1 },
    { id: 'n20', name: '浮木',     icon: '🪵', value: 2 },
    { id: 'n21', name: '水蛭',     icon: '🪱', value: 2 },
    { id: 'n22', name: '河蚬',     icon: '🦪', value: 2 },
    { id: 'n23', name: '鲢鱼',     icon: '🐟', value: 5 },
    { id: 'n24', name: '鳙鱼',     icon: '🐟', value: 6 },
    { id: 'n25', name: '草鱼',     icon: '🐟', value: 6 },
    { id: 'n26', name: '鲂鱼',     icon: '🐟', value: 5 },
    { id: 'n27', name: '黄鳝',     icon: '🐟', value: 6 },
    { id: 'n28', name: '塘角鱼',   icon: '🐟', value: 5 },
    { id: 'n29', name: '小螃蟹',   icon: '🦀', value: 5 },
    { id: 'n30', name: '水黾',     icon: '🦟', value: 1 },
    { id: 'n31', name: '石蚕虫',   icon: '🐛', value: 2 },
    { id: 'n32', name: '荷叶',     icon: '🪷', value: 2 },
    { id: 'n33', name: '芦苇',     icon: '🌾', value: 1 },
    { id: 'n34', name: '溪石',     icon: '🪨', value: 1 },
    { id: 'n35', name: '溪虾',     icon: '🦐', value: 3 },
    { id: 'n36', name: '泥螺',     icon: '🐌', value: 2 },
    { id: 'n37', name: '鲮鱼',     icon: '🐟', value: 4 },
    { id: 'n38', name: '翘嘴',     icon: '🐟', value: 6 },
    { id: 'n39', name: '鳑鲏',     icon: '🐟', value: 4 },
    { id: 'n40', name: '小甲鱼',   icon: '🐢', value: 8 }
  ],
  R: [
    { id: 'r1',  name: '鲈鱼',       icon: '🐟', value: 10 },
    { id: 'r2',  name: '鳜鱼',       icon: '🐟', value: 14 },
    { id: 'r3',  name: '河豚',       icon: '🐡', value: 12 },
    { id: 'r4',  name: '螃蟹',       icon: '🦀', value: 10 },
    { id: 'r5',  name: '鱿鱼',       icon: '🦑', value: 14 },
    { id: 'r6',  name: '黑鱼',       icon: '🐟', value: 13 },
    { id: 'r7',  name: '大鲶鱼',     icon: '🐟', value: 12 },
    { id: 'r8',  name: '白鳝',       icon: '🐟', value: 15 },
    { id: 'r9',  name: '甲鱼',       icon: '🐢', value: 16 },
    { id: 'r10', name: '鲟鱼',       icon: '🐟', value: 18 },
    { id: 'r11', name: '大闸蟹',     icon: '🦀', value: 15 },
    { id: 'r12', name: '青蟹',       icon: '🦀', value: 14 },
    { id: 'r13', name: '三文鱼',     icon: '🐟', value: 15 },
    { id: 'r14', name: '金枪鱼',     icon: '🐟', value: 16 },
    { id: 'r15', name: '带鱼',       icon: '🐟', value: 12 },
    { id: 'r16', name: '黄花鱼',     icon: '🐟', value: 14 },
    { id: 'r17', name: '石斑鱼',     icon: '🐟', value: 16 },
    { id: 'r18', name: '鲷鱼',       icon: '🐟', value: 15 },
    { id: 'r19', name: '沙丁鱼',     icon: '🐟', value: 10 },
    { id: 'r20', name: '秋刀鱼',     icon: '🐟', value: 11 },
    { id: 'r21', name: '凤尾鱼',     icon: '🐟', value: 10 },
    { id: 'r22', name: '银鲳鱼',     icon: '🐟', value: 13 },
    { id: 'r23', name: '多宝鱼',     icon: '🐟', value: 15 },
    { id: 'r24', name: '海螺',       icon: '🐚', value: 12 },
    { id: 'r25', name: '扇贝',       icon: '🦪', value: 13 },
    { id: 'r26', name: '海星',       icon: '⭐', value: 11 },
    { id: 'r27', name: '墨鱼',       icon: '🦑', value: 13 },
    { id: 'r28', name: '大龙虾',     icon: '🦞', value: 18 },
    { id: 'r29', name: '青鱼',       icon: '🐟', value: 13 },
    { id: 'r30', name: '鳊鱼',       icon: '🐟', value: 11 }
  ],
  SR: [
    { id: 's1',  name: '海豚',       icon: '🐬', value: 60 },
    { id: 's2',  name: '章鱼',       icon: '🐙', value: 55 },
    { id: 's3',  name: '鲨鱼',       icon: '🦈', value: 80 },
    { id: 's4',  name: '金龙鱼',     icon: '🐉', value: 90 },
    { id: 's5',  name: '娃娃鱼',     icon: '🐟', value: 70 },
    { id: 's6',  name: '旗鱼',       icon: '🐟', value: 75 },
    { id: 's7',  name: '剑鱼',       icon: '🐟', value: 78 },
    { id: 's8',  name: '蓝鳍金枪鱼', icon: '🐟', value: 85 },
    { id: 's9',  name: '龙趸',       icon: '🐟', value: 70 },
    { id: 's10', name: '帝王蟹',     icon: '🦀', value: 90 },
    { id: 's11', name: '龙虾王',     icon: '🦞', value: 72 },
    { id: 's12', name: '巨型石斑',   icon: '🐟', value: 68 },
    { id: 's13', name: '翻车鱼',     icon: '🐟', value: 60 },
    { id: 's14', name: '魟鱼',       icon: '🐟', value: 65 },
    { id: 's15', name: '电鳗',       icon: '🐟', value: 62 },
    { id: 's16', name: '鹦鹉螺',     icon: '🐚', value: 66 },
    { id: 's17', name: '狮子鱼',     icon: '🐟', value: 58 },
    { id: 's18', name: '蝠鲼',       icon: '🐟', value: 76 },
    { id: 's19', name: '大王乌贼',   icon: '🦑', value: 88 },
    { id: 's20', name: '苏眉鱼',     icon: '🐟', value: 74 }
  ],
  SSR: [
    { id: 'x1',  name: '传说锦鲤',   icon: '🎏', value: 500 },
    { id: 'x2',  name: '深海巨鲲',   icon: '🐋', value: 888 },
    { id: 'x3',  name: '白鲸',       icon: '🐳', value: 560 },
    { id: 'x4',  name: '虎鲸',       icon: '🐬', value: 600 },
    { id: 'x5',  name: '蓝鲸',       icon: '🐳', value: 700 },
    { id: 'x6',  name: '美人鱼',     icon: '🧜', value: 999 },
    { id: 'x7',  name: '龙王鱼',     icon: '🐉', value: 1000 },
    { id: 'x8',  name: '沧龙',       icon: '🦖', value: 888 },
    { id: 'x9',  name: '黄金旗鱼',   icon: '🐟', value: 650 },
    { id: 'x10', name: '深渊灯笼鱼', icon: '🏮', value: 520 }
  ]
};

// ---------- 稀有度与道具 ----------

// 基础概率：N 60% / R 30% / SR 9% / SSR 1%
const BASE_WEIGHTS = { N: 0.60, R: 0.30, SR: 0.09, SSR: 0.01 };
const RARITY_ORDER = ['N', 'R', 'SR', 'SSR'];

// 商店道具：买完立即生效，接下来 casts 次抛竿有效。boost 加在对应档位上，增量全部从 N 档扣除。
// 定价依据期望回收率（道具全周期预期收益 / 售价，按 100 鱼均值估算）：
//   幸运饵   0.15×(R13.4−N3.2)×5竿 ≈ 7.7 币 / 售 6   → 1.28
//   诱食剂   0.12×(SR72−N3.2)×3竿   ≈ 24.8 币 / 售 20 → 1.24
//   黄金鱼饵 (0.15×68.9+0.07×727.4)×2竿 ≈ 122.5 / 售 120 → 1.02
//   龙王秘药 0.25×(SSR730.5−N3.2)×1竿   ≈ 181.8 / 售 180 → 1.01
const SHOP_ITEMS = [
  { id: 'bait_r',   name: '幸运饵',     icon: '🪱', price: 6,    casts: 5, boost: { R: 0.15 } },
  { id: 'bait_sr',  name: '浓香诱食剂', icon: '🧪', price: 20,   casts: 3, boost: { SR: 0.12 } },
  { id: 'bait_ssr', name: '黄金鱼饵',   icon: '✨', price: 120,  casts: 2, boost: { SR: 0.15, SSR: 0.07 } },
  { id: 'bait_ult', name: '龙王秘药',   icon: '🌟', price: 180,  casts: 1, boost: { SSR: 0.25 } }
];

/** 按当前生效增益计算实际概率（增量全部从 N 档扣）。 */
function effectiveWeights(buffs) {
  const w = Object.assign({}, BASE_WEIGHTS);
  let extra = 0;
  for (const buff of Array.isArray(buffs) ? buffs : []) {
    const boost = buff && buff.boost;
    if (!boost) continue;
    for (const key of Object.keys(boost)) {
      if (!(key in w)) continue;
      w[key] += boost[key];
      if (key !== 'N') extra += boost[key];
    }
  }
  w.N = Math.max(0, w.N - extra);
  return w;
}

function rollRarity(weights) {
  const r = Math.random();
  let acc = 0;
  for (const key of RARITY_ORDER) {
    acc += weights[key];
    if (r < acc) return key;
  }
  return 'N';
}

const CATCH_FLAVOR = {
  N:   ['普通的一条，聊胜于无', '嗯……不算稀奇', '今天的水有点普通'],
  R:   ['不错的收获！', '这条像模像样', '手感很棒！'],
  SR:  ['哇，大家伙！', '稀客稀客！', '这条能吹一年！'],
  SSR: ['传·说·级！快截图！', '史诗中鱼！！', '这运气可以买彩票了！']
};

// 咬钩手感：稀有度在咬钩瞬间预抽定型，气泡/徽标/文案随档位差异化。
// 徽标硬限制：每段 ≤4 码点，tone ∈ primary/warning/success/danger/muted。
const BITE_FEEL = {
  N:   { bubble: '咬钩了！快收杆！',         badge: '鱼讯!', tone: 'danger',  status: '普通鱼讯，可能是小鱼' },
  R:   { bubble: '咬钩了！手感不错！',       badge: '鱼讯!', tone: 'danger',  status: '手感有点分量' },
  SR:  { bubble: '竿尖猛地一沉——大家伙！',  badge: '大鱼!', tone: 'warning', status: '竿尖在抖，明显是大鱼！' },
  SSR: { bubble: '水面炸开了！！速收杆！！', badge: '巨物!', tone: 'danger',  status: '水面都在震动！！' }
};

const RARITY_LABEL = { SR: '史诗', SSR: '传说' };

// ---------- 每日任务与跨插件联动 ----------
const TODO_COMPLETED_EVENT = 'todo-reminder:completed';   // todo 插件的完成契约事件
const TODO_COMMISSION = 5;                                // 每条待办完成的「摸鱼佣金」

const QUEST_POOL = [
  { id: 'casts_5',    desc: '抛 5 竿',          target: 5,  reward: 8,  metric: 'casts' },
  { id: 'catch_3',    desc: '中 3 条鱼',         target: 3,  reward: 12, metric: 'catches' },
  { id: 'catch_r',    desc: '中 1 条 R+ 鱼',    target: 1,  reward: 18, metric: 'catchRPlus' },
  { id: 'catch_sr',   desc: '中 1 条 SR+ 鱼',   target: 1,  reward: 40, metric: 'catchSRPlus' },
  { id: 'earn_50',    desc: '渔获入账 50 币',    target: 50, reward: 10, metric: 'earnedToday' },
  { id: 'buy_1',      desc: '买 1 件道具',       target: 1,  reward: 10, metric: 'buys' },
  { id: 'todo_1',     desc: '完成 1 条待办',     target: 1,  reward: 25, metric: 'todoDone' }
];

// ---------- 每日经营圈（v0.5.0：签到 / 日报 / 行情 / 天气 / 成就） ----------

// 图鉴里程碑：集齐 n 种 → 一次性金币奖 + AI 祝贺（no-key 降级预写台词）
const DEX_MILESTONES = [
  { n: 10,  reward: 50 },
  { n: 30,  reward: 150 },
  { n: 60,  reward: 400 },
  { n: 100, reward: 1000 }
];

// 签到：连续第 1 天 +5，之后每天 +1，第 7 天起封顶 +11；断签从 1 重来
function signReward(streak) { return 5 + Math.min(Math.max(1, streak) - 1, 6); }

// 鱼市行情：每天随机一种鱼涨价（稀有度越高倍率越低，避免 SSR 翻倍白送 500+），
// 抽中分布偏向 N/R——今天真能钓到的鱼才有行情意义
const MARKET_MULTS = { N: 3, R: 2, SR: 1.5, SSR: 1.5 };
const MARKET_RARITY_WEIGHTS = { N: 0.5, R: 0.35, SR: 0.1, SSR: 0.05 };

// 天气鱼情：open-meteo 免 key，weather_code → 鱼情增益（增量从 N 扣，与道具同机制）。
// 缓存 3 小时；请求失败 30 分钟后再试；失败/无网完全不影响玩法。
const WEATHER_TTL_MS = 3 * 60 * 60 * 1000;
const WEATHER_RETRY_MS = 30 * 60 * 1000;
const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=39.9042&longitude=116.4074&current=weather_code&timezone=Asia%2FShanghai';
const WEATHER_MAP = [
  { codes: [63, 65, 66, 67, 81, 82],        desc: '大雨',   emoji: '🌧', boost: { SR: 0.10, SSR: 0.04 } },
  { codes: [51, 53, 55, 56, 57, 61, 80],    desc: '小雨',   emoji: '🌦', boost: { SR: 0.08, SSR: 0.03 } },
  { codes: [71, 73, 75, 77, 85, 86, 95, 96, 99], desc: '风雪雷暴', emoji: '⛈', boost: { SR: 0.10, SSR: 0.05 } },
  { codes: [2, 3, 45, 48],                  desc: '多云',   emoji: '☁️', boost: { R: 0.05 } },
  { codes: [0, 1],                          desc: '晴天',   emoji: '☀️', boost: {} }
];

const REPORT_TIME = '23:58';   // 日报播报点（宿主那时在线才播，错过不补）

let sdk = null;
const timerIds = new Set();
const pendingTasks = new Set();   // ai 台词等游离异步任务，持有引用防止被提前回收

// ---------- 存档 ----------

function emptySave() {
  return {
    coins: 0,
    session: null,
    log: [],
    dex: {},
    buffs: [],
    stats: { casts: 0, catches: 0, escapes: 0, bestValue: 0, earned: 0, spent: 0, today: { date: '', casts: 0, catches: 0, earned: 0, best: null } },
    quests: null,
    sign: { last: '', streak: 0 },
    market: null,
    weather: null,
    achievements: { claimed: [] }
  };
}

async function readSave(pet) {
  const raw = await pet.storage.get(SAVE_KEY, null);
  const base = emptySave();
  if (!raw || typeof raw !== 'object') return base;
  const save = {
    coins: Number(raw.coins) || 0,
    session: raw.session && typeof raw.session === 'object' ? raw.session : null,
    log: Array.isArray(raw.log) ? raw.log.slice(0, MAX_LOG) : [],
    dex: raw.dex && typeof raw.dex === 'object' ? raw.dex : {},
    buffs: Array.isArray(raw.buffs) ? raw.buffs.filter((b) => b && b.id) : [],
    stats: Object.assign(base.stats, raw.stats && typeof raw.stats === 'object' ? raw.stats : {}),
    // v0.4.0 的教训：新字段必须在这里规范化透传，否则每次读档都会被丢掉
    quests: raw.quests && typeof raw.quests === 'object' && Array.isArray(raw.quests.list)
      ? { date: String(raw.quests.date || ''), list: raw.quests.list }
      : null,
    sign: raw.sign && typeof raw.sign === 'object'
      ? { last: String(raw.sign.last || ''), streak: Number(raw.sign.streak) || 0 }
      : { last: '', streak: 0 },
    market: raw.market && typeof raw.market === 'object' && raw.market.fishId ? raw.market : null,
    weather: raw.weather && typeof raw.weather === 'object' ? raw.weather : null,
    achievements: raw.achievements && typeof raw.achievements === 'object' && Array.isArray(raw.achievements.claimed)
      ? { claimed: raw.achievements.claimed }
      : { claimed: [] }
  };
  save.stats.today = Object.assign(
    { date: '', casts: 0, catches: 0, earned: 0, best: null },
    save.stats.today && typeof save.stats.today === 'object' ? save.stats.today : {}
  );
  return save;
}

async function writeSave(pet, save) {
  await pet.storage.set(SAVE_KEY, save);
  await pet.events.emit(CHANGED_EVENT, { scope: 'fishing' }).catch(() => {});
}

function allFish() {
  return RARITY_ORDER.flatMap((rarity) => FISH_POOL[rarity].map((f) => Object.assign({}, f, { rarity })));
}

function findFish(rarity, id) {
  return (FISH_POOL[rarity] || []).find((f) => f.id === id) || null;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickFlavor(rarity) {
  const list = CATCH_FLAVOR[rarity] || CATCH_FLAVOR.N;
  return list[Math.floor(Math.random() * list.length)];
}

// ---------- 徽标（最多 2 段、每段 ≤4 码点）----------

async function syncBadge(pet, save) {
  try {
    const s = save || (await readSave(pet));
    if (s.session) {
      const feel = BITE_FEEL[s.session.preRarity] || BITE_FEEL.N;
      await pet.badge.set({ segments: [{ tone: feel.tone, text: feel.badge }], onClick: 'openPanel' });
    } else {
      await pet.badge.clear();
    }
  } catch (err) {
    // 徽标名额被其它插件占用属可预期冲突，静默让位。
  }
}

// ---------- 道具 ----------

async function buyItem(pet, itemId) {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) return { ok: false, error: '没有这个道具：' + itemId };
  const save = await readSave(pet);
  if (save.coins < item.price) {
    return { ok: false, error: '金币不够：需要 ' + item.price + '，现有 ' + save.coins };
  }
  save.coins -= item.price;
  save.stats.spent = (save.stats.spent || 0) + item.price;
  await bumpQuest(pet, save, 'buys', 1);
  save.buffs.push({ id: item.id, name: item.name, icon: item.icon, castsLeft: item.casts, boost: item.boost });
  await writeSave(pet, save);
  return { ok: true, item: { id: item.id, name: item.name }, coins: save.coins, castsLeft: item.casts };
}

/** 抛竿时消耗增益：返回本次生效概率（extraBuffs 只参与计算、不耗耐久，用于天气鱼情），
 *  并把已用完的增益清掉。会直接改传入 save。 */
function consumeBuffs(save, extraBuffs) {
  const weights = effectiveWeights(save.buffs.concat(Array.isArray(extraBuffs) ? extraBuffs : []));
  save.buffs = save.buffs
    .map((b) => Object.assign({}, b, { castsLeft: (b.castsLeft || 0) - 1 }))
    .filter((b) => b.castsLeft > 0);
  return weights;
}

// ---------- 核心玩法 ----------

async function castRod(pet) {
  const save = await readSave(pet);
  if (save.session) {
    return { ok: false, error: '已经在钓鱼了' };
  }
  await ensureDaily(pet, save);
  // 抛竿即咬钩：立刻进入收杆窗口，点收杆马上出结果。
  // 稀有度在咬钩瞬间预抽定型（手感）——同时修复 v0.2.0 增益不生效的问题
  // （旧实现收杆时重抽，而耐久已在抛竿时被消耗，等于永远按基础概率出鱼）。
  const now = Date.now();
  // 天气增益不耗耐久：临时拼进权重计算，与道具增益同机制（增量从 N 扣）
  const weatherBoost = save.weather && save.weather.boost && Object.keys(save.weather.boost).length
    ? [{ boost: save.weather.boost }]
    : [];
  const weights = consumeBuffs(save, weatherBoost);
  const preRarity = rollRarity(weights);
  const feel = BITE_FEEL[preRarity];
  save.session = {
    castAt: now,
    biteAt: now,
    biteUntil: now + BITE_WINDOW_MS,
    stage: 'bite',
    preRarity
  };
  save.stats.casts += 1;
  bumpToday(save).casts += 1;
  await bumpQuest(pet, save, 'casts', 1);
  await writeSave(pet, save);
  await syncBadge(pet, save);
  await pet.pet.playAnim(preRarity === 'SSR' ? 'greet' : 'unread').catch(() => {});
  await pet.pet.bubble(feel.bubble, BUBBLE_MS_BITE);
  await pet.events.emit(BITE_EVENT, { at: now, windowMs: BITE_WINDOW_MS, preRarity }).catch(() => {});
  return { ok: true, stage: 'bite', weights, preRarity, message: feel.bubble + ' 45 秒内收杆！' };
}

async function reelRod(pet) {
  const save = await readSave(pet);
  if (!save.session) return { ok: false, error: '还没抛竿' };

  const now = Date.now();
  if (save.session.stage !== 'bite') {
    save.session = null;
    await writeSave(pet, save);
    await syncBadge(pet, save);
    await pet.pet.bubble('太心急了，什么都没钓到…', BUBBLE_MS_CATCH);
    return { ok: false, error: '太早收杆了，鱼还没咬钩', escaped: false };
  }

  // 咬钩窗口内收杆 → 中鱼（鱼种已在咬钩瞬间预抽定型，这里只落具体鱼）
  const sessionRarity = save.session.preRarity;
  const rarityKey = RARITY_ORDER.includes(sessionRarity)
    ? sessionRarity
    : rollRarity(effectiveWeights(save.buffs));   // 兜底：老存档会话没有 preRarity
  const fish = findFish(rarityKey, pick(FISH_POOL[rarityKey]).id) || FISH_POOL.N[0];
  // 鱼市行情：今日行情鱼按倍率结算（其余鱼原价）
  const marketMult = save.market && save.market.fishId === fish.id ? Number(save.market.mult) || 1 : 1;
  const payout = Math.round(fish.value * marketMult);
  save.coins += payout;
  save.dex[fish.id] = (save.dex[fish.id] || 0) + 1;
  save.log.unshift({ fishId: fish.id, name: fish.name, icon: fish.icon, rarity: rarityKey, value: payout, ts: now });
  if (save.log.length > MAX_LOG) save.log.length = MAX_LOG;
  save.stats.catches += 1;
  save.stats.earned = (save.stats.earned || 0) + payout;
  const today = bumpToday(save);
  today.catches += 1;
  today.earned += payout;
  if (!today.best || payout > today.best.value) today.best = { name: fish.name, value: payout };
  await bumpQuest(pet, save, 'catches', 1);
  await bumpQuest(pet, save, 'earnedToday', payout);
  if (rarityKey !== 'N') await bumpQuest(pet, save, 'catchRPlus', 1);
  if (rarityKey === 'SR' || rarityKey === 'SSR') await bumpQuest(pet, save, 'catchSRPlus', 1);
  if (payout > save.stats.bestValue) save.stats.bestValue = payout;
  await checkMilestones(pet, save);   // 图鉴里程碑：新集齐种数达标 → 发奖（随后统一落盘）
  save.session = null;
  await writeSave(pet, save);
  await syncBadge(pet, save);

  const msg = pickFlavor(rarityKey) + '：' + fish.icon + fish.name + '（' + rarityKey + '）+' + payout + ' 币'
    + (marketMult > 1 ? '（行情 ×' + marketMult + '）' : '');
  await pet.pet.bubble(msg, BUBBLE_MS_CATCH);
  if (rarityKey === 'SR' || rarityKey === 'SSR') {
    await pet.pet.playAnim('greet').catch(() => {});
    queueCatchStory(pet, fish, rarityKey, now);
  }
  return { ok: true, fish: Object.assign({}, fish, { value: payout }), rarity: rarityKey, coins: save.coins, message: msg };
}

async function giveUp(pet) {
  const save = await readSave(pet);
  if (!save.session) return { ok: false, error: '本来就没在钓鱼' };
  save.session = null;
  await writeSave(pet, save);
  await syncBadge(pet, save);
  return { ok: true, message: '收竿回家，改日再战' };
}

// ---------- ai 台词（SR/SSR 专属，失败静默降级为预写台词）----------

function catchStoryPrompt(fish, rarityKey) {
  return '你陪我钓鱼，刚钓到' + (RARITY_LABEL[rarityKey] || rarityKey) + '级鱼「' + fish.name
    + '」（价值 ' + fish.value + ' 金币）。用一句不超过 30 字的中文台词表达惊喜，语气活泼，不要引号，不要解释。';
}

/** 游离任务：不阻塞收杆返回；成功后把台词补写进最新渔获记录并再次冒泡。 */
function queueCatchStory(pet, fish, rarityKey, caughtAt) {
  const task = (async () => {
    let text = '';
    try {
      text = String((await pet.ai.chat(catchStoryPrompt(fish, rarityKey))) || '').trim();
    } catch (err) {
      return;   // no-key / 限流：保留预写台词，静默降级
    }
    if (!text) return;
    text = text.slice(0, 60);
    try {
      const cur = await readSave(pet);
      const top = Array.isArray(cur.log) && cur.log[0];
      if (top && top.fishId === fish.id && top.ts === caughtAt) {   // 只补自己那条，防竞态覆盖
        top.story = text;
        await writeSave(pet, cur);
      }
      await pet.pet.bubble(text, BUBBLE_MS_STORY);
    } catch (err) { /* 存档竞态等：台词进不了记录就算了 */ }
  })();
  pendingTasks.add(task);
  const drop = () => pendingTasks.delete(task);
  task.then(drop, drop);
}

// ---------- 每日任务 ----------

function dateStr(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function todayStr() { return dateStr(Date.now()); }

function makeQuests() {
  const pool = QUEST_POOL.slice();
  const list = [];
  for (let i = 0; i < 3 && pool.length; i++) {
    const q = pool.splice(Math.floor(Math.random() * pool.length), 1)[0];
    list.push({ id: q.id, desc: q.desc, target: q.target, reward: q.reward, metric: q.metric, progress: 0, done: false });
  }
  return { date: todayStr(), list };
}

/** 惰性跨天刷新：不依赖 scheduler，任何存档访问点都能触发；跨天时播报一次。 */
async function ensureQuests(pet, save) {
  if (save.quests && save.quests.date === todayStr()) return false;
  const rollover = !!save.quests;
  save.quests = makeQuests();
  await writeSave(pet, save);
  if (rollover) await pet.pet.bubble('今日钓鱼任务已刷新！', BUBBLE_MS_CATCH).catch(() => {});
  return true;
}

/** 任务进度推进；达标自动发奖并冒泡（由调用方随后 writeSave 落盘）。 */
async function bumpQuest(pet, save, metric, amount) {
  if (!save.quests || !amount) return;
  for (const q of save.quests.list) {
    if (q.done || q.metric !== metric) continue;
    q.progress = Math.min(q.target, q.progress + amount);
    if (q.progress >= q.target) {
      q.done = true;
      save.coins += q.reward;
      await pet.pet.bubble('任务完成「' + q.desc + '」+' + q.reward + ' 币！', BUBBLE_MS_CATCH).catch(() => {});
    }
  }
}

// ---------- 每日经营圈（v0.5.0） ----------

/** 今日小计：跨天自动归零（惰性，不依赖定时器）。 */
function bumpToday(save) {
  const today = todayStr();
  if (!save.stats.today || save.stats.today.date !== today) {
    save.stats.today = { date: today, casts: 0, catches: 0, earned: 0, best: null };
  }
  return save.stats.today;
}

/** 每日开档总入口：任务刷新 + 签到 + 行情 + 天气，任何存档访问点都能惰性触发。 */
async function ensureDaily(pet, save) {
  await ensureQuests(pet, save);
  await ensureSignIn(pet, save);
  await ensureMarket(pet, save);
  await ensureWeather(pet, save);
}

/** 连续签到：每天首次触达自动签（断签重置，奖励 5~11 币递增）。 */
async function ensureSignIn(pet, save) {
  const today = todayStr();
  if (save.sign.last === today) return;
  save.sign.streak = save.sign.last === dateStr(Date.now() - 86400000) ? save.sign.streak + 1 : 1;
  save.sign.last = today;
  const reward = signReward(save.sign.streak);
  save.coins += reward;
  await writeSave(pet, save);
  await pet.pet.bubble('签到！连续 ' + save.sign.streak + ' 天，+' + reward + ' 币', BUBBLE_MS_CATCH).catch(() => {});
}

/** 每日鱼市行情：随机一种鱼涨价，AI 编行情词（失败降级模板），收购结算时生效。 */
async function ensureMarket(pet, save) {
  const today = todayStr();
  if (save.market && save.market.date === today) return;
  let acc = Math.random();
  let rarity = 'N';
  for (const key of RARITY_ORDER) {
    acc -= MARKET_RARITY_WEIGHTS[key];
    if (acc < 0) { rarity = key; break; }
  }
  const fish = pick(FISH_POOL[rarity]);
  save.market = { date: today, fishId: fish.id, name: fish.name, icon: fish.icon, rarity, mult: MARKET_MULTS[rarity], line: '' };
  await writeSave(pet, save);
  queueMarketLine(pet, save.market);
}

function marketLinePrompt(m) {
  return '你经营着一个鱼摊。今日行情：「' + m.name + '」收购价涨到 ' + m.mult + ' 倍。用一句不超过 25 字的中文吆喝播报这条行情，语气像鱼市小贩，不要引号，不要解释。';
}
function fallbackMarketLine(m) {
  return '今日「' + m.name + '」走俏，收购价 ×' + m.mult + '！';
}

function queueMarketLine(pet, market) {
  const task = (async () => {
    let text = '';
    try {
      text = String((await pet.ai.chat(marketLinePrompt(market))) || '').trim();
    } catch (err) { /* no-key / 限流：降级保底模板 */ }
    if (!text) text = fallbackMarketLine(market);
    try {
      const cur = await readSave(pet);
      if (cur.market && cur.market.date === market.date && cur.market.fishId === market.fishId && !cur.market.line) {
        cur.market.line = text.slice(0, 50);
        await writeSave(pet, cur);
      }
    } catch (err) { /* 存档竞态：行情词丢了就算了 */ }
  })();
  pendingTasks.add(task);
  const drop = () => pendingTasks.delete(task);
  task.then(drop, drop);
}

/** 天气鱼情：拉 open-meteo 现况，映射成稀有度增益；缓存 3 小时，失败 30 分钟后再试。 */
async function ensureWeather(pet, save) {
  const w = save.weather;
  if (w && Date.now() - Number(w.fetchedAt) < WEATHER_TTL_MS) return;
  let next = null;
  try {
    const res = await pet.net.fetch(WEATHER_URL);
    const data = JSON.parse(res && res.body != null ? String(res.body) : '{}');
    const code = data && data.current ? Number(data.current.weather_code) : NaN;
    if (Number.isFinite(code)) {
      const hit = WEATHER_MAP.find((m) => m.codes.includes(code)) || { desc: '阴天', emoji: '🌫', boost: {} };
      next = { fetchedAt: Date.now(), code, desc: hit.desc, emoji: hit.emoji, boost: hit.boost };
    }
  } catch (err) { /* 无网 / 限权 / 超时：鱼情按无增益处理 */ }
  if (!next) {
    // 30 分钟后再试：把 fetchedAt 回拨，让顶部 TTL 守卫（3h）自然挡住这段窗口
    next = { fetchedAt: Date.now() - WEATHER_TTL_MS + WEATHER_RETRY_MS, ok: false };
  }
  const changed = !w || w.desc !== next.desc;
  save.weather = next;
  await writeSave(pet, save);
  if (changed && next.boost && Object.keys(next.boost).length) {
    await pet.pet.bubble('外面' + next.desc + '，鱼开口了！' + weatherBoostText(next.boost), BUBBLE_MS_CATCH).catch(() => {});
  }
}

function weatherBoostText(boost) {
  return RARITY_ORDER.filter((k) => boost[k]).map((k) => k + '+' + Math.round(boost[k] * 100) + '%').join(' ');
}

/** 图鉴里程碑：达成的未领奖一次性发奖 + 冒泡 + AI 祝贺（游离任务）。 */
async function checkMilestones(pet, save) {
  const count = Object.keys(save.dex).length;
  for (const m of DEX_MILESTONES) {
    if (count < m.n || save.achievements.claimed.includes(m.n)) continue;
    save.achievements.claimed.push(m.n);
    save.coins += m.reward;
    await pet.pet.bubble('图鉴集齐 ' + m.n + ' 种！奖励 +' + m.reward + ' 币！', BUBBLE_MS_STORY).catch(() => {});
    queueMilestoneStory(pet, m);
  }
}

function queueMilestoneStory(pet, milestone) {
  const task = (async () => {
    let text = '';
    try {
      const prompt = '主人钓鱼图鉴集齐了 ' + milestone.n + ' 种鱼（满 100 种），我发了 ' + milestone.reward
        + ' 金币奖励。用一句不超过 30 字的中文台词祝贺，语气活泼，不要引号，不要解释。';
      text = String((await pet.ai.chat(prompt)) || '').trim();
    } catch (err) { return; }   // no-key / 限流：前面已冒泡过奖励，不再打扰
    if (text) await pet.pet.bubble(text.slice(0, 60), BUBBLE_MS_STORY).catch(() => {});
  })();
  pendingTasks.add(task);
  const drop = () => pendingTasks.delete(task);
  task.then(drop, drop);
}

/** 23:58 日报：今天玩过才播，错过不补（依赖宿主在线）。 */
async function dailyReport(pet) {
  try {
    const save = await readSave(pet);
    const t = save.stats.today;
    if (!t || t.date !== todayStr() || (!t.casts && !t.catches)) return;
    const parts = ['今日钓鱼小结：抛 ' + t.casts + ' 竿中 ' + t.catches + ' 条，入账 ' + t.earned + ' 币'];
    if (t.best) parts.push('最贵 ' + t.best.name + ' ' + t.best.value + ' 币');
    if (save.market && save.market.fishId) parts.push('明天行情见分晓');
    await pet.pet.bubble(parts.join('，'), BUBBLE_MS_STORY).catch(() => {});
  } catch (err) { /* 日报失败无所谓 */ }
}

// ---------- 巡检 ----------

async function tick(pet) {
  const save = await readSave(pet);
  if (!save.session) return;
  const now = Date.now();

  if (save.session.stage === 'bite' && now > save.session.biteUntil) {
    // 错过窗口：跑鱼
    save.session = null;
    save.stats.escapes += 1;
    await writeSave(pet, save);
    await syncBadge(pet, save);
    await pet.pet.bubble('哎呀，鱼跑了…', BUBBLE_MS_CATCH);
  }
}

// ---------- Agent 工具 ----------

function describeSession(save) {
  if (!save.session) return '空闲（未抛竿）';
  const left = Math.max(0, Math.round((save.session.biteUntil - Date.now()) / 1000));
  const feel = BITE_FEEL[save.session.preRarity] || BITE_FEEL.N;
  return '咬钩中！' + left + ' 秒内收杆！手感：' + feel.status;
}

function describeBuffs(save) {
  return (save.buffs || []).map((b) => b.icon + b.name + '·剩' + b.castsLeft + '竿');
}

function registerTools(pet) {
  pet.tools.register({
    name: 'fishing_cast',
    promptHint: '钓鱼游戏：抛竿。抛出后立刻咬钩，45 秒内收杆即可中鱼。',
    schema: { type: 'object', properties: {} },
    async handler() { return castRod(pet); }
  });

  pet.tools.register({
    name: 'fishing_reel',
    promptHint: '钓鱼游戏：收杆。咬钩后收杆钓上鱼，按稀有度结算金币。',
    schema: { type: 'object', properties: {} },
    async handler() { return reelRod(pet); }
  });

  pet.tools.register({
    name: 'fishing_status',
    promptHint: '钓鱼游戏：查看当前状态（是否咬钩、剩余时间、金币、生效增益、今日任务进度、签到/行情/天气）。',
    schema: { type: 'object', properties: {} },
    async handler() {
      const save = await readSave(pet);
      await ensureDaily(pet, save);
      const weatherBoost = save.weather && save.weather.boost ? save.weather.boost : {};
      return {
        ok: true,
        status: describeSession(save),
        coins: save.coins,
        catches: save.stats.catches,
        escapes: save.stats.escapes,
        buffs: describeBuffs(save),
        quests: save.quests.list.map((q) => q.desc + ' ' + q.progress + '/' + q.target + (q.done ? '（已完成）' : '')),
        sign: save.sign.last === todayStr() ? '今日已签，连续 ' + save.sign.streak + ' 天' : '今日未签',
        market: save.market
          ? '今日行情：' + save.market.icon + save.market.name + ' 收购价 ×' + save.market.mult + (save.market.line ? '「' + save.market.line + '」' : '')
          : '',
        weather: save.weather && save.weather.desc
          ? save.weather.emoji + save.weather.desc + (weatherBoostText(weatherBoost) ? '，鱼情 ' + weatherBoostText(weatherBoost) : '，鱼情平稳')
          : ''
      };
    }
  });

  pet.tools.register({
    name: 'fishing_fishdex',
    promptHint: '钓鱼游戏：查看图鉴（100 种鱼的捕获次数）、生涯统计与收集里程碑进度。',
    schema: { type: 'object', properties: {} },
    async handler() {
      const save = await readSave(pet);
      const flat = allFish();
      return {
        ok: true,
        dexProgress: Object.keys(save.dex).length + '/' + flat.length,
        coins: save.coins,
        stats: save.stats,
        buffs: describeBuffs(save),
        milestones: DEX_MILESTONES.map((m) => '集齐 ' + m.n + ' 种 +' + m.reward + ' 币'
          + (save.achievements.claimed.includes(m.n) ? '（已达成）' : '（进行中）')),
        dex: flat.map((f) => ({ name: f.name, value: f.value, caught: save.dex[f.id] || 0 }))
      };
    }
  });

  pet.tools.register({
    name: 'fishing_giveup',
    promptHint: '钓鱼游戏：收竿回家（结束当前钓鱼会话，不结算）。',
    schema: { type: 'object', properties: {} },
    async handler() { return giveUp(pet); }
  });

  pet.tools.register({
    name: 'fishing_shop_list',
    promptHint: '钓鱼游戏：查看道具商城（价格、增益效果、生效竿数）。',
    schema: { type: 'object', properties: {} },
    async handler() {
      const save = await readSave(pet);
      return {
        ok: true,
        coins: save.coins,
        items: SHOP_ITEMS.map((i) => ({
          id: i.id, name: i.name, icon: i.icon, price: i.price, casts: i.casts,
          effect: RARITY_ORDER.filter((k) => i.boost[k]).map((k) => k + '+' + Math.round(i.boost[k] * 100) + '%').join(' ')
        }))
      };
    }
  });

  pet.tools.register({
    name: 'fishing_shop_buy',
    promptHint: '钓鱼游戏：购买道具增益（按稀有度提升中鱼概率，接下来 N 竿有效）。',
    schema: {
      type: 'object',
      properties: { itemId: { type: 'string', description: '道具 id，如 bait_ult' } },
      required: ['itemId']
    },
    async handler(args) { return buyItem(pet, String(args.itemId || '')); }
  });
}

// ---------- 生命周期 ----------

exports.activate = async function activate(pet) {
  sdk = pet;

  registerTools(pet);

  // 花名册与商店表下发（panel/card 动态读取，单一数据源）
  await pet.storage.set(CATALOG_KEY, allFish());
  await pet.storage.set(SHOP_KEY, SHOP_ITEMS.map((i) => ({
    id: i.id, name: i.name, icon: i.icon, price: i.price, casts: i.casts,
    effect: RARITY_ORDER.filter((k) => i.boost[k]).map((k) => k + '+' + Math.round(i.boost[k] * 100) + '%').join(' ')
  })));

  timerIds.add(await pet.scheduler.every(TICK_MS, () => tick(pet)));
  timerIds.add(await pet.scheduler.daily(REPORT_TIME, () => dailyReport(pet)));

  // panel/card 的动作通道：{ action: 'cast' | 'reel' | 'buy', itemId? }
  pet.events.on(ACTION_EVENT, (payload) => {
    const action = payload && payload.action;
    if (action === 'cast') castRod(pet).catch(() => {});
    else if (action === 'reel') reelRod(pet).catch(() => {});
    else if (action === 'buy') buyItem(pet, payload.itemId).catch(() => {});
  });

  // todo 联动：待办完成 → 摸鱼佣金 + 推进「完成待办」任务（跨插件经济圈）
  pet.events.on(TODO_COMPLETED_EVENT, async () => {
    try {
      const save = await readSave(pet);
      await ensureQuests(pet, save);
      save.coins += TODO_COMMISSION;
      await bumpQuest(pet, save, 'todoDone', 1);
      await writeSave(pet, save);
      await pet.pet.bubble('干得漂亮！摸鱼佣金 +' + TODO_COMMISSION + ' 币', BUBBLE_MS_CATCH);
    } catch (err) { /* 联动失败不影响钓鱼本体 */ }
  });

  // panel/card 存档变更后刷新徽标
  pet.events.on(CHANGED_EVENT, () => {
    syncBadge(pet).catch(() => {});
    tick(pet).catch(() => {});
  });

  // 重启恢复：旧会话不追赶（简化处理），视为跑鱼
  try {
    const save = await readSave(pet);
    if (save.session) {
      save.session = null;
      save.stats.escapes += 1;
      await pet.storage.set(SAVE_KEY, save);
    }
  } catch (err) { /* 首次启动无存档，忽略 */ }
  await syncBadge(pet);
};

exports.deactivate = async function deactivate() {
  if (!sdk) return;
  for (const id of timerIds) {
    try { await sdk.scheduler.cancel(id); } catch (err) { /* 已失效定时器忽略 */ }
  }
  timerIds.clear();
  try { await sdk.badge.clear(); } catch (err) { /* 徽标已被宿主回收 */ }
  sdk = null;
};

// 供测试脚本直接校验概率数学
exports._effectiveWeights = effectiveWeights;
exports._BASE_WEIGHTS = BASE_WEIGHTS;
exports._BITE_FEEL = BITE_FEEL;
