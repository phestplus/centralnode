import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, registryFile } from './util.ts';

export type Project = { id: string; name: string; path: string; registeredAt: string; lastLinkedAt?: string };

/** The nearest folder at or above `from` that has a package.json. */
export function findRoot(from = process.cwd()): string | null {
  let d = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export const projects = (): Project[] => readJson(registryFile(), { projects: [] as Project[] }).projects;
const save = (list: Project[]) => writeJson(registryFile(), { version: 1, projects: list });
const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

export function register(root: string): Project {
  const list = projects();
  const found = list.find((p) => same(p.path, root));
  if (found) return found;
  const pkg = readJson(path.join(root, 'package.json'), {} as any);
  const p: Project = { id: crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 12), name: pkg.name || path.basename(root), path: path.resolve(root), registeredAt: new Date().toISOString() };
  save([...list, p]);
  return p;
}

export function touch(root: string) {
  const list = projects();
  const p = list.find((x) => same(x.path, root));
  if (p) { p.lastLinkedAt = new Date().toISOString(); save(list); }
}

export function unregister(root: string) { save(projects().filter((p) => !same(p.path, root))); }
export function prune() { const all = projects(); const keep = all.filter((p) => fs.existsSync(path.join(p.path, 'package.json'))); save(keep); return all.length - keep.length; }

/** The .git folder for a project, following worktree pointer files. Null if not a Git checkout. */
export function gitDir(root: string): string | null {
  let d = path.resolve(root);
  for (;;) {
    const g = path.join(d, '.git');
    try {
      const s = fs.statSync(g);
      if (s.isDirectory()) return g;
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(g, 'utf8'));
      if (m) return path.resolve(d, m[1].trim());
    } catch {}
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Add `.centralnode/` to the checkout's own exclude list (never .gitignore, which the team shares). */
export function excludeFromGit(root: string): 'added' | 'present' | 'no-git' {
  const g = gitDir(root);
  if (!g) return 'no-git';
  const file = path.join(g, 'info', 'exclude');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (text.split(/\r?\n/).some((l) => l.trim() === '.centralnode/' || l.trim() === '/.centralnode/')) return 'present';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + '# CentralNode (local only)\n.centralnode/\n');
  return 'added';
}

export function initProject(root: string) {
  const p = register(root);
  const cfgPath = path.join(root, '.centralnode', 'config.json');
  if (!fs.existsSync(cfgPath)) writeJson(cfgPath, { version: 1, projectId: p.id, enabled: true, mode: 'linked', packageManager: 'npm' });
  const git = excludeFromGit(root);
  return { project: p, git };
}
