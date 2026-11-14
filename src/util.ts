import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';

/** Where CentralNode keeps everything. One place for the whole computer. */
export const isWindows = process.platform === 'win32';

/** The default home for each OS: Windows %LOCALAPPDATA%, macOS ~/Library/Application Support, Linux $XDG_DATA_HOME or ~/.local/share. */
function defaultHome(): string {
  if (process.env.CENTRALNODE_HOME) return process.env.CENTRALNODE_HOME;
  if (isWindows) return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'CentralNode');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'CentralNode');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'centralnode');
}
export function home(): string {
  const def = defaultHome();
  const cfg = readJson(path.join(def, 'config.json'), {} as any);
  return cfg.storeDir ? path.resolve(cfg.storeDir) : def;
}
export const configFile = () => path.join(defaultHome(), 'config.json');

/** Paths compare without case on Windows and macOS (their file systems ignore case), exactly on Linux. */
export const pathKey = (p: string) => (isWindows || process.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));
export const filesDir = () => path.join(home(), 'store', 'v1', 'files');
export const indexDir = () => path.join(home(), 'store', 'v1', 'index');
export const registryFile = () => path.join(home(), 'projects', 'registry.json');
export const locksDir = () => path.join(home(), 'locks');
export const tempDir = () => path.join(home(), 'temp');

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** Write through a temp file and a rename, so a crash never leaves half a file. */
export function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

export function bytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (e: any) { return e.code === 'EPERM'; } };

/** A simple cross-process lock. A lock left by a process that has died is taken over. */
export async function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const dir = path.join(locksDir(), name + '.lock');
  fs.mkdirSync(locksDir(), { recursive: true });
  for (let tries = 0; ; tries++) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'pid'), String(process.pid));
      break;
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(path.join(dir, 'pid'), { encoding: 'utf8', flag: 'a+' }) || 0);
      if (pid && !alive(pid)) { fs.rmSync(dir, { recursive: true, force: true }); continue; }
      if (tries === 0) console.log(`Waiting for another CentralNode process (${pid || 'starting'})...`);
      if (tries > 1200) throw new Error(`Store is locked by process ${pid}. If it is gone, delete ${dir}.`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const release = () => fs.rmSync(dir, { recursive: true, force: true });
  process.once('exit', release);
  try { return await fn(); } finally { release(); process.removeListener('exit', release); }
}

/** Run npm (or another tool) with the console attached. Resolves to the exit code. */
// npm's update check can hang for minutes on networks with broken IPv6, after the real work is done. Never needed here.
const quiet = (cmd: string, args: string[]) => (cmd === 'npm' && args.length ? [args[0], '--no-update-notifier', ...args.slice(1)] : args);

export function run(cmd: string, args: string[], cwd: string): Promise<number> {
  args = quiet(cmd, args);
  return new Promise((resolve) => {
    // Windows needs a shell to start npm.cmd; elsewhere npm is started directly, so no quoting is needed.
    const quoted = isWindows ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
    const child = spawn(cmd, quoted, { cwd, stdio: 'inherit', shell: isWindows });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    child.on('error', () => resolve(1));
  });
}

export function capture(cmd: string, args: string[], cwd = process.cwd()): Promise<string> {
  args = quiet(cmd, args);
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { cwd, shell: isWindows });
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

export const sameVolume = (a: string, b: string) => {
  try { return fs.statSync(a).dev === fs.statSync(b).dev; } catch { return pathKey(path.parse(path.resolve(a)).root) === pathKey(path.parse(path.resolve(b)).root); }
};
