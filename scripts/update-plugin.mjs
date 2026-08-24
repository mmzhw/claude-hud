import { cpSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 将构建产物同步到 Claude Code 已安装的 claude-hud 插件缓存目录。
 *
 * 为什么不用 `claude plugin update`：它按 git commit 对比，工作区有未提交修改时
 * 不会同步；`claude plugin install` 对已安装插件直接跳过。本地开发循环需要直接拷贝。
 *
 * 目标目录从 installed_plugins.json 读取，版本号升级后会自动跟随新的 installPath。
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
const registryPath = join(configDir, 'plugins', 'installed_plugins.json');

const PLUGIN_ID = 'claude-hud@claude-hud';
const SYNC_ITEMS = ['dist', 'commands', '.claude-plugin'];

if (!existsSync(registryPath)) {
  console.log(`[update-plugin] 未找到插件注册表 ${registryPath}，跳过`);
  process.exit(0);
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const entries = registry.plugins?.[PLUGIN_ID] ?? [];
if (entries.length === 0) {
  console.log(
    `[update-plugin] 插件 ${PLUGIN_ID} 未安装，跳过（可运行 claude plugin install ${PLUGIN_ID} -y）`
  );
  process.exit(0);
}

const entry =
  entries.filter((it) => it.scope === 'user').at(-1) ?? entries.at(-1);
if (!entry.installPath || !existsSync(entry.installPath)) {
  console.log(`[update-plugin] 安装路径不存在: ${entry.installPath}，跳过`);
  process.exit(0);
}

for (const item of SYNC_ITEMS) {
  const from = join(repositoryRoot, item);
  if (!existsSync(from)) continue;
  // dist 采用镜像同步（先清后拷），避免源码中已删除的文件残留在缓存里
  if (item === 'dist') {
    rmSync(join(entry.installPath, item), { recursive: true, force: true });
  }
  cpSync(from, join(entry.installPath, item), { recursive: true, force: true });
  console.log(`[update-plugin] 已同步 ${item}`);
}

const distEntry = join(entry.installPath, 'dist', 'index.js');
const mtime = existsSync(distEntry)
  ? statSync(distEntry).mtime.toLocaleString()
  : '未找到';
console.log(`[update-plugin] 完成: ${distEntry} (${mtime})`);
