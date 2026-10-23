import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DATA = path.join(ROOT, 'data');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const runId = prefix => `${prefix}-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
export function safeId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,120}$/.test(value) || value.includes('..')) throw new Error('Invalid identifier');
  return value;
}
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  try {
    // Windows can briefly deny replacement while a dashboard reader or virus
    // scanner holds the previous file. Preserve atomic replacement and retry;
    // never truncate the live JSON file to work around a sharing violation.
    for(let attempt=0;;attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch(error) {
        if(!['EPERM','EACCES','EBUSY'].includes(error.code)||attempt>=8)throw error;
        await sleep(Math.min(25*2**attempt,250));
      }
    }
  } finally { await fs.unlink(temporary).catch(()=>{}); }
}
export async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export async function treeHashes(root) {
  const files = {};
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in snapshots: ${full}`);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name !== 'session.lock') files[path.relative(root, full).replaceAll('\\', '/')] = sha256(await fs.readFile(full));
    }
  }
  await walk(root);
  return files;
}
export async function loadScenario(id) {
  const own = await readJson(path.join(ROOT, 'scenarios', `${safeId(id)}.json`));
  const parent = own.extends ? await loadScenario(own.extends) : {};
  const config = { ...parent, ...own };
  delete config.extends;
  return validateScenario(config);
}
export function validateScenario(config) {
  if (!/^[-]?\d+$/.test(config.seed) || !['1.16.1', '1.16.5'].includes(config.minecraft)) throw new Error('Unsupported seed/version');
  if (!['peaceful', 'easy', 'normal', 'hard'].includes(config.difficulty)) throw new Error('Invalid difficulty');
  if (!(config.durationSeconds > 0 && config.durationSeconds <= 3600)) throw new Error('Invalid time budget');
  if (!['real', 'paused'].includes(config.clock ?? 'real')) throw new Error('Invalid clock');
  if (config.snapshot !== undefined) safeId(config.snapshot);
  const goal = config.goal ?? { type: 'dragon' };
  if (!['dragon', 'milestone', 'items'].includes(goal.type) || (goal.type === 'items' && !(/^[a-z0-9_]+$/.test(goal.item) && goal.count >= 1)) || (goal.type === 'milestone' && !/^[a-zA-Z0-9]+$/.test(goal.name ?? ''))) throw new Error('Invalid goal');
  const start = config.start ?? {};
  for (const area of start.load ?? []) if (!['overworld', 'the_nether', 'the_end'].includes(area[0]) || area.length !== 5 || !area.slice(1).every(Number.isInteger)) throw new Error('Invalid load area');
  for (const [item, count] of start.kit ?? []) if (!/^[a-z0-9_]+$/.test(item) || !(count >= 1 && count <= 64)) throw new Error('Invalid kit');
  for (const command of start.commands ?? []) if (typeof command !== 'string' || /^\s*(op|deop|stop|save|whitelist|ban|pardon|kick|reload)\b/.test(command)) throw new Error('Invalid setup command');
  return config;
}
// What the agent is told: hidden landmarks are referee-only (structure locations the course does not disclose).
export const sharedLandmarks = scenario => (scenario.landmarks ?? []).filter(l => !l.hidden).map(({ hidden, ...l }) => l);
export function offlineUuid(name) {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x30; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const s = bytes.toString('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
export const PLAYER = 'BenchAgent';
export const PLAYER_UUID = offlineUuid(PLAYER);
export function errorText(error) { return error instanceof Error ? error.message : String(error); }
