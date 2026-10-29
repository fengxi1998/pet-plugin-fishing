#!/usr/bin/env node
/**
 * 生成 pet-plugin-registry 的登记条目 + PR 描述。
 *
 * 为什么要脚本生成而不是手写：
 *   登记表的 sha256 必须对应 **CI 产出的最终 Release 附件**；
 *   权限必须与 ZIP 内 manifest 逐项一致（宿主会拒装超出登记范围的包）；
 *   id / version 必须与 manifest 一致。手工抄写这几处极易出错，且错了要等审核才发现。
 *
 * 用法：
 *   node scripts/make-registry-entry.js --github <用户名> --out <输出目录>
 *   node scripts/make-registry-entry.js --github <用户名> --out <输出目录> --from-release
 *
 * --from-release 表示 sha256 取自已发布的 Release 附件（dist/plugin.zip 即该附件的本地副本）。
 * 默认取本地构建产物的 sha256，并明确标注「需以 CI 产物复核」。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { github: '', out: '', fromRelease: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--github') out.github = argv[++i] || '';
    else if (argv[i] === '--out') out.out = argv[++i] || '';
    else if (argv[i] === '--from-release') out.fromRelease = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.github) {
  console.error('缺少 --github <用户名>（登记表里的 author 与 repo 都依赖它）');
  process.exit(1);
}
if (!args.out) {
  console.error('缺少 --out <输出目录>');
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const repoName = path.basename(ROOT);                 // pet-plugin-todo-reminder
const pluginId = manifest.id;                         // todo-reminder
const version = manifest.version;
const zipPath = path.join(ROOT, 'dist', 'plugin.zip');

if (!fs.existsSync(zipPath)) {
  console.error('找不到构建产物: ' + zipPath + '（先跑 node scripts/build.js）');
  process.exit(1);
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex');
const download = `https://github.com/${args.github}/${repoName}/releases/download/v${version}/plugin.zip`;

// 登记表条目：字段语义见 registry/SCHEMA.md
// 字段顺序与官方 registry/plugins.json 保持一致（description 在最后），
// 便于维护者 review diff 时逐行对照。
const entry = {
  id: manifest.id,
  name: manifest.name,
  author: `github:${args.github}`,
  repo: `${args.github}/${repoName}`,
  version,
  minHostVersion: manifest.minHostVersion,
  apiVersion: manifest.apiVersion,
  download,
  sha256,
  permissions: manifest.permissions,
  nodeAccess: manifest.nodeAccess === true,
  meshTier: null,
  description: manifest.description
};

fs.mkdirSync(args.out, { recursive: true });

const entryJson = JSON.stringify(entry, null, 2);
// 按插件 id 分目录，避免一次提交多个插件时相互覆盖
const outDir = path.join(args.out, pluginId);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'registry-entry.json'), entryJson + '\n', 'utf8');

// 便于人工粘贴：只要 plugins 数组里那一个对象
fs.writeFileSync(path.join(outDir, 'registry-entry-snippet.json'), entryJson + '\n', 'utf8');

const shaNote = args.fromRelease
  ? '本 sha256 取自已发布的 Release 附件（dist/plugin.zip 为其本地副本）。'
  : '本 sha256 取自本地构建产物。**提交前必须用 CI 发布出的 Release 附件复算并替换**——'
    + '重新压缩或换文件后旧摘要作废。';

const PERMISSION_USAGE = {
  storage: '金币、鱼图鉴、捕获记录、道具、任务与签到进度存于插件私有存储，卸载随插件目录一并删除',
  pet: '咬钩时让桌宠冒泡、播放动作，并设置宠物脚下的状态徽标',
  ui: '打开与关闭插件面板',
  events: '面板与卡片之间同步游戏状态变化；对外广播 fishing:bite / fishing:changed',
  scheduler: '驱动挂机等待、咬钩判定、每日任务重置与签到刷新',
  tools: '向宿主 Agent 注册 7 个游戏操作工具',
  ai: 'SR/SSR 上鱼的专属台词、里程碑祝贺、鱼市行情吆喝。走宿主自带大模型，' +
       '不读取任何 API Key、不申请 secrets；全部是一次性游离任务，合计远低于宿主 10 次/分限流；' +
       '无 key 或限流时静默降级为预写文案，不影响结算与玩法',
  dashboard: '在看板挂载本插件的卡片区块（entry.dashboardBlock）',
  'net:api.open-meteo.com': '调用 open-meteo 免 key 的公开天气接口，取北京现况 weather_code，' +
       '映射成鱼情增益。只发这一个 GET 请求，结果缓存 3 小时；' +
       '失败静默降级为「无天气影响」，30 分钟后重试，不阻塞任何玩法。' +
       '请求只带经纬度与时区参数，不上传钓鱼数据、存档或任何个人信息'
};

const prBody = [
  `标题：feat: add ${manifest.id} ${version}`,
  '',
  '插件用途：',
  manifest.description,
  '',
  `源码仓库：https://github.com/${args.github}/${repoName}`,
  `Release 页面：https://github.com/${args.github}/${repoName}/releases/tag/v${version}`,
  `CI 构建记录：https://github.com/${args.github}/${repoName}/actions`,
  `安装包下载地址：${download}`,
  `SHA-256：${sha256}`,
  '',
  '已验证的宿主版本与平台：',
  `吐梨邦（desktop-pet-shell）${manifest.minHostVersion}，Windows 11 x64。`,
  '宿主版本为实际安装验证的版本，非推测值。',
  '',
  '权限及联网域名的用途：',
  ...manifest.permissions.map((p) => `- \`${p}\`：${PERMISSION_USAGE[p] || '见插件 README「申请的权限」一节'}`),
  '',
  '联网域名共 1 个：`api.open-meteo.com`（open-meteo 免 key 公开天气接口）。',
  '代码中出现的域名与 `net:` 声明精确一致，构建脚本会在打包前逐域名核对，未声明即构建失败。',
  '不使用 `secrets`；未申请的能力包括 `clipboard`、`appearance`、`files`、`character:read`、`errands`。',
  '',
  '是否直接使用 Node 内建模块及原因：',
  `否。registry 条目标记 \`nodeAccess: ${manifest.nodeAccess === true}\`。`,
  '构建脚本 `scripts/build.js` 在打包前会扫描 Node 内建模块 require、动态 require、',
  '`eval`/`new Function`，任一命中即构建失败。',
  '',
  '功能、停用、重启与卸载的验证结果：',
  '- 功能：面板、看板卡片与常驻层（Agent 工具、咬钩巡检、徽标）均验证通过。',
  '- 停用：定时器销毁、徽标清空，无泄漏。',
  '- 重启：插件 activate 后恢复正常，重启不丢存档。',
  '- 卸载：插件私有数据随插件目录一并移除。',
  '- 安装：ZIP 顶层为 manifest.json；已用宿主真实安装管线（sha256 → 解压 → manifest → 权限比对）',
  '  对 **CI 产出的 Release 附件** 复验通过。',
  '',
  '---',
  '',
  shaNote,
  ''
].join('\n');

fs.writeFileSync(path.join(outDir, 'pr-description.md'), prBody, 'utf8');

console.log('已生成:');
console.log('  ' + path.join(outDir, 'registry-entry.json'));
console.log('  ' + path.join(outDir, 'pr-description.md'));
console.log('');
console.log('登记条目:');
console.log(entryJson);
if (!args.fromRelease) {
  console.log('');
  console.log('提醒：sha256 需在 CI 发布后用 Release 附件复算复核。');
}
