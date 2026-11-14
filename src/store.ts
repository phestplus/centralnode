import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { filesDir, indexDir, hashFile, readJson, writeJson } from './util.ts';

/*
 * The central store. Every distinct file from every node_modules is kept once, named by its SHA-256.
 * A project's node_modules keeps its normal layout, but each file in it is a hard link to the store copy,
 * so it takes no extra space. npm, Node, TypeScript, Vite and Next.js all see an ordinary folder.
 *
 * A store file whose link count is 1 is used by nobody, and `cn clean` can remove it.
 */

// Folders that tools write into while running. Sharing those would let one project change another's files.
const SKIP_DIRS = new Set(['.cache', '.vite', '.vite-temp', '.tmp', '.turbo', '.parcel-cache', '.angular', '.next', '.nuxt', '.svelte-kit', '.gradle', '.cxx', '.expo']);
// Files npm rewrites in place on every install.
const SKIP_FILES = new Set(['.package-lock.json', '.yarn-integrity', '.modules.yaml']);
const MAX_LINKS = 1000; // NTFS allows 1023 per file; keep headroom.

export type LinkStats = { files: number; linked: number; already: number; stored: number; skipped: number; busy: number; savedBytes: number; busyFiles: string[] };

export const storePath = (hash: string, slot = 0) => path.join(filesDir(), hash.slice(0, 2), hash.slice(2) + (slot ? `.${slot}` : ''));

function* walk(dir: string, top: string): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    // Never follow links or junctions: they point at something we do not own (npm workspaces, file: deps).
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      // Android builds write into node_modules/<pkg>/android/build; keep those private to the project.
      if (SKIP_DIRS.has(e.name) || (e.name === 'build' && path.basename(dir) === 'android')) continue;
      yield* walk(p, top);
      continue;
    }
    if (!e.isFile()) continue;
    if (dir === top && SKIP_FILES.has(e.name)) continue;
    yield p;
  }
}

function isJunction(p: string) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Replace `file` with a hard link to `target`, atomically. The original stays if anything fails. */
function replaceWithLink(target: string, file: string) {
  const tmp = `${file}.cn-${crypto.randomBytes(4).toString('hex')}`;
  fs.linkSync(target, tmp);
  try {
    fs.renameSync(tmp, file);
  } catch (e: any) {
    if (e.code === 'EPERM' || e.code === 'EACCES') {
      // A read-only file cannot be replaced on Windows. Make it writable and try once more.
      try { fs.chmodSync(file, 0o666); fs.renameSync(tmp, file); return; } catch {}
    }
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

type Index = Record<string, { size: number; mtime: number; ino: number; hash: string }>;
const indexFile = (key: string) => path.join(indexDir(), crypto.createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 24) + '.json');

/**
 * Move every file of a node_modules folder into the central store and leave hard links behind.
 * Safe to run again at any time: files already linked are recognised quickly from the index.
 */
export async function linkFolder(nodeModules: string, onProgress?: (n: number) => void): Promise<LinkStats> {
  const st: LinkStats = { files: 0, linked: 0, already: 0, stored: 0, skipped: 0, busy: 0, savedBytes: 0, busyFiles: [] };
  if (!fs.existsSync(nodeModules) || isJunction(nodeModules)) return st;
  const top = nodeModules;
  const idxPath = indexFile(top);
  const old: Index = readJson(idxPath, {});
  const idx: Index = {};
  for (const file of walk(top, top)) {
    st.files++;
    if (onProgress && st.files % 2000 === 0) onProgress(st.files);
    const rel = path.relative(top, file);
    let s: fs.Stats;
    try { s = fs.statSync(file); } catch { st.skipped++; continue; }
    if (s.size === 0) { st.skipped++; continue; } // empty files gain nothing and hit link limits
    const known = old[rel];
    if (known && known.size === s.size && known.mtime === s.mtimeMs && known.ino === s.ino && s.nlink > 1) {
      const sp = storePath(known.hash);
      try { if (fs.statSync(sp).ino === s.ino) { st.already++; idx[rel] = known; continue; } } catch {}
    }
    let hash: string;
    try { hash = await hashFile(file); } catch { st.skipped++; continue; }
    try {
      const r = place(file, hash, s);
      if (r === 'already') st.already++;
      else if (r === 'stored') st.stored++;
      else { st.linked++; st.savedBytes += s.size; }
      const ns = fs.statSync(file);
      idx[rel] = { size: ns.size, mtime: ns.mtimeMs, ino: ns.ino, hash };
    } catch (e: any) {
      if (['EBUSY', 'EPERM', 'EACCES'].includes(e.code)) { st.busy++; if (st.busyFiles.length < 20) st.busyFiles.push(rel); }
      else st.skipped++;
    }
  }
  writeJson(idxPath, idx);
  return st;
}

/** Put one file in the store. Returns what happened. */
function place(file: string, hash: string, s: fs.Stats): 'stored' | 'linked' | 'already' {
  for (let slot = 0; slot < 50; slot++) {
    const sp = storePath(hash, slot);
    let ss: fs.Stats | null = null;
    try { ss = fs.statSync(sp); } catch {}
    if (!ss) {
      // New content: the store adopts this very file. No copy is made.
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.linkSync(file, sp);
      return 'stored';
    }
    if (ss.ino === s.ino && ss.dev === s.dev) return 'already';
    if (ss.size !== s.size) throw Object.assign(new Error(`Store file ${sp} is damaged (size differs). Run cn store verify.`), { code: 'ECORRUPT' });
    if (ss.nlink >= MAX_LINKS) continue; // this copy is full; use the next slot
    try { replaceWithLink(sp, file); return 'linked'; } catch (e: any) { if (e.code === 'EMLINK') continue; throw e; }
  }
  throw Object.assign(new Error('Too many links'), { code: 'EMLINK' });
}

function* storeFiles(): Generator<string> {
  const root = filesDir();
  let tops: string[];
  try { tops = fs.readdirSync(root); } catch { return; }
  for (const t of tops) {
    let names: string[];
    try { names = fs.readdirSync(path.join(root, t)); } catch { continue; }
    for (const n of names) yield path.join(root, t, n);
  }
}

/** Measured numbers, from the link counts on disk. */
export function storeStatus() {
  let files = 0, physical = 0, unused = 0, unusedBytes = 0, references = 0, withoutStore = 0;
  for (const f of storeFiles()) {
    let s: fs.Stats;
    try { s = fs.statSync(f); } catch { continue; }
    files++; physical += s.size;
    const users = s.nlink - 1;
    references += users;
    if (users <= 0) { unused++; unusedBytes += s.size; }
    // Without CentralNode each user would hold its own copy.
    withoutStore += s.size * Math.max(users, 1);
  }
  return { files, physical, references, unused, unusedBytes, saved: withoutStore - physical, withoutStore };
}

/** Re-hash every stored file. A file changed in place by some tool shows up here. */
export async function verifyStore(onBad: (file: string) => void) {
  let checked = 0, bad = 0;
  for (const f of storeFiles()) {
    const name = path.basename(path.dirname(f)) + path.basename(f).replace(/\.\d+$/, '');
    const h = await hashFile(f).catch(() => '');
    checked++;
    if (h !== name) { bad++; onBad(f); }
  }
  return { checked, bad };
}

/** Remove store files no project uses any more. */
export function cleanStore(dryRun: boolean) {
  let removed = 0, freed = 0;
  for (const f of storeFiles()) {
    let s: fs.Stats;
    try { s = fs.statSync(f); } catch { continue; }
    if (s.nlink > 1) continue;
    removed++; freed += s.size;
    if (!dryRun) { try { fs.chmodSync(f, 0o666); fs.rmSync(f); } catch { removed--; freed -= s.size; } }
  }
  return { removed, freed };
}

/** Size of a folder counting each physical file once (what it really costs on disk). */
export function folderCost(dir: string) {
  let apparent = 0, own = 0, files = 0;
  for (const f of walk(dir, dir)) {
    try { const s = fs.statSync(f); files++; apparent += s.size; if (s.nlink <= 1) own += s.size; } catch {}
  }
  return { files, apparent, own };
}
