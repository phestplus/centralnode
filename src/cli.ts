import fs from 'node:fs';
import path from 'node:path';
import { home, filesDir, configFile, readJson, writeJson, bytes, withLock, run, capture, sameVolume } from './util.ts';
import { linkFolder, storeStatus, verifyStore, cleanStore, folderCost, type LinkStats } from './store.ts';
import { findRoot, initProject, register, touch, projects, prune, unregister } from './project.ts';

const VERSION = '0.1.0';
const HELP = `CentralNode ${VERSION}: one package store for the whole computer.

Projects
  cn init                      Set up this project (local only, excluded from Git)
  cn install [--offline]       npm install, then link node_modules to the central store
  cn ci                        npm ci, then link
  cn add [-D] pkg[@ver] ...    Add packages (npm writes package.json and the lockfile)
  cn remove pkg ...            Remove packages
  cn run <script> [args]       Run a package.json script
  cn link [path]               Link an existing node_modules to the store (no download)
  cn adopt <folder> [--dry-run]  Find every project under a folder and link them all
  cn status                    This project: real disk cost of node_modules
  cn projects                  Registered projects

Global tools
  cn add -g pkg ...            npm install -g, then link
  cn global list | update | remove <pkg>

Store
  cn store status | path | verify
  cn clean [--dry-run] [--yes] Delete store files no project uses
  cn config get | set store-dir <path>
  cn doctor                    Check this computer is set up correctly
`;

const say = (s = '') => console.log(s);
const nm = (root: string) => path.join(root, 'node_modules');

function report(st: LinkStats, label: string) {
  say(`  ${label}: ${st.files} files · ${st.stored} new to the store · ${st.linked} now shared · ${st.already} already shared${st.skipped ? ` · ${st.skipped} skipped` : ''}`);
  if (st.savedBytes) say(`  Freed now: ${bytes(st.savedBytes)}`);
  if (st.busy) {
    say(`  ${st.busy} files were in use and stay as they are. Close dev servers and editors, then run "cn link" again.`);
    for (const f of st.busyFiles.slice(0, 5)) say(`    ${f}`);
  }
}

async function linkProject(root: string, quiet = false) {
  if (!fs.existsSync(nm(root))) { if (!quiet) say('  No node_modules to link.'); return null; }
  const vol = sameVolume(root, home());
  if (!vol) { say(`  Skipped: ${root} is on a different drive from the store (${home()}). Hard links cannot cross drives.`); return null; }
  register(root);
  const st = await withLock('store', () => linkFolder(nm(root), (n) => process.stdout.write(`\r  Linking... ${n} files`)));
  if (st.files >= 2000) process.stdout.write('\r' + ' '.repeat(40) + '\r');
  touch(root);
  return st;
}

function needRoot(): string {
  const r = findRoot();
  if (!r) { say('No package.json here or above. Run this inside a project.'); process.exit(1); }
  return r;
}

async function npmThenLink(root: string, args: string[]) {
  const code = await run('npm', args, root);
  if (code !== 0) { say(`\nnpm exited with code ${code}. Nothing was linked.`); return code; }
  say('\nCentralNode');
  const st = await linkProject(root);
  if (st) report(st, 'node_modules');
  return 0;
}

async function globalRoot() { return path.join((await capture('npm', ['root', '-g'])) || '', ''); }

function findProjects(base: string, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return out; }
  if (entries.some((e) => e.name === 'package.json' && e.isFile()) && entries.some((e) => e.name === 'node_modules' && e.isDirectory())) out.push(base);
  for (const e of entries) {
    if (!e.isDirectory() || e.isSymbolicLink()) continue;
    if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'dist' || e.name === 'build' || e.name === 'out') continue;
    findProjects(path.join(base, e.name), depth + 1, out);
  }
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith('-')));
  const args = rest.filter((a) => !a.startsWith('-'));

  switch (cmd) {
    case undefined: case 'help': case '--help': case '-h': say(HELP); return 0;
    case 'version': case '--version': case '-v': say(VERSION); return 0;

    case 'init': {
      const root = needRoot();
      const { project, git } = initProject(root);
      say(`CentralNode ${VERSION}\n`);
      say(`Project: ${project.name}`);
      say(`Git: ${git === 'no-git' ? 'not a Git checkout' : git === 'added' ? '.centralnode/ added to .git/info/exclude' : 'already excluded'}`);
      say(`node_modules: ${fs.existsSync(nm(root)) ? 'found (run "cn link" to share it)' : 'not installed yet (run "cn install")'}`);
      say(`Store: ${home()}`);
      return 0;
    }

    case 'install': case 'i': {
      const root = needRoot(); initProject(root);
      return npmThenLink(root, ['install', ...(flags.has('--offline') ? ['--offline'] : []), ...rest.filter((a) => a !== '--offline')]);
    }
    case 'ci': { const root = needRoot(); initProject(root); return npmThenLink(root, ['ci', ...rest]); }

    case 'add': {
      if (!args.length) { say('Usage: cn add [-D] [-g] package[@version] ...'); return 1; }
      if (flags.has('-g') || flags.has('--global')) {
        const code = await run('npm', ['install', '-g', ...args], process.cwd());
        if (code) return code;
        const g = await globalRoot();
        say('\nCentralNode');
        if (!sameVolume(g, home())) { say(`  Global folder ${g} is on another drive; not linked.`); return 0; }
        report(await withLock('store', () => linkFolder(g)), 'global packages');
        return 0;
      }
      const root = needRoot(); initProject(root);
      const dev = flags.has('-D') || flags.has('--save-dev');
      return npmThenLink(root, ['install', ...(dev ? ['--save-dev'] : []), ...args]);
    }

    case 'remove': case 'rm': case 'uninstall': {
      if (!args.length) { say('Usage: cn remove package ...'); return 1; }
      if (flags.has('-g')) return run('npm', ['uninstall', '-g', ...args], process.cwd());
      const root = needRoot();
      const code = await run('npm', ['uninstall', ...args], root);
      if (!code) say('Removed. Shared files other projects use are kept; run "cn clean" to free files nobody uses.');
      return code;
    }

    case 'run': {
      if (!args.length) { say('Usage: cn run <script> [args]'); return 1; }
      return run('npm', ['run', ...rest], needRoot());
    }

    case 'link': {
      const root = args[0] ? path.resolve(args[0]) : needRoot();
      initProject(root);
      say(`Linking ${root}`);
      const st = await linkProject(root);
      if (st) report(st, 'node_modules');
      return 0;
    }

    case 'adopt': {
      const base = path.resolve(args[0] ?? process.cwd());
      const found = findProjects(base);
      say(`Found ${found.length} projects with node_modules under ${base}\n`);
      if (flags.has('--dry-run')) {
        let total = 0, own = 0;
        for (const p of found) { const c = folderCost(nm(p)); total += c.apparent; own += c.own; say(`  ${bytes(c.own).padStart(9)} on disk  ${p}`); }
        say(`\nnode_modules use ${bytes(own)} of their own disk space now (${bytes(total)} counting shared files). Run without --dry-run to link them.`);
        return 0;
      }
      let freed = 0, busy = 0;
      for (const [i, p] of found.entries()) {
        say(`[${i + 1}/${found.length}] ${p}`);
        try {
          initProject(p);
          const st = await linkProject(p, true);
          if (st) { report(st, 'node_modules'); freed += st.savedBytes; busy += st.busy; }
        } catch (e: any) { say(`  Failed: ${e.message}`); }
      }
      say(`\nDone. Freed ${bytes(freed)}.${busy ? ` ${busy} files were in use; run "cn adopt" again after closing editors and dev servers.` : ''}`);
      return 0;
    }

    case 'status': {
      const root = needRoot();
      const p = projects().find((x) => path.resolve(x.path).toLowerCase() === root.toLowerCase());
      say(`Project: ${root}`);
      say(`Registered: ${p ? 'yes' : 'no (run "cn init")'}`);
      if (!fs.existsSync(nm(root))) { say('node_modules: not installed'); return 0; }
      const c = folderCost(nm(root));
      say(`node_modules: ${c.files} files, ${bytes(c.apparent)} as listed, ${bytes(c.own)} not shared (the only part using its own disk space)`);
      return 0;
    }

    case 'projects': {
      const n = prune();
      const list = projects();
      if (!list.length) say('No projects yet. Run "cn init" in one, or "cn adopt C:\\dev".');
      for (const p of list) say(`${p.name.padEnd(32)} ${p.path}${p.lastLinkedAt ? `  (linked ${p.lastLinkedAt.slice(0, 10)})` : ''}`);
      if (n) say(`\n(${n} deleted projects removed from the list)`);
      return 0;
    }
    case 'forget': { unregister(args[0] ? path.resolve(args[0]) : needRoot()); say('Removed from the list.'); return 0; }

    case 'global': {
      const sub = args[0];
      if (sub === 'list') return run('npm', ['ls', '-g', '--depth=0'], process.cwd());
      if (sub === 'remove') return run('npm', ['uninstall', '-g', ...args.slice(1)], process.cwd());
      if (sub === 'update') {
        const code = await run('npm', ['update', '-g', ...args.slice(1)], process.cwd());
        if (!code) { const g = await globalRoot(); if (sameVolume(g, home())) report(await withLock('store', () => linkFolder(g)), 'global packages'); }
        return code;
      }
      say('Usage: cn global list | update [pkg] | remove <pkg>'); return 1;
    }

    case 'store': {
      const sub = args[0] ?? 'status';
      if (sub === 'path') { say(home()); return 0; }
      if (sub === 'status') {
        const s = storeStatus();
        say(`Store: ${home()}`);
        say(`Files: ${s.files}, ${bytes(s.physical)} on disk`);
        say(`Uses by projects: ${s.references}`);
        say(`Without CentralNode these would take: ${bytes(s.withoutStore)}`);
        say(`Saved: ${bytes(s.saved)}`);
        say(`Not used by any project: ${s.unused} files, ${bytes(s.unusedBytes)} (cn clean frees this)`);
        say(`Projects registered: ${projects().length}`);
        return 0;
      }
      if (sub === 'verify') {
        say('Checking every stored file...');
        const r = await verifyStore((f) => say(`  Changed: ${f}`));
        say(`${r.checked} checked, ${r.bad} changed.${r.bad ? ' A tool edited a shared file in place. Reinstall the affected project with "cn install".' : ''}`);
        return r.bad ? 2 : 0;
      }
      say('Usage: cn store status | path | verify'); return 1;
    }

    case 'clean': {
      const dry = flags.has('--dry-run');
      const preview = cleanStore(true);
      if (!preview.removed) { say('Nothing to clean. Every stored file is used by a project.'); return 0; }
      say(`${preview.removed} files (${bytes(preview.freed)}) are not used by any project.`);
      if (dry) return 0;
      if (!flags.has('--yes') && !flags.has('-y')) { say('Run "cn clean --yes" to delete them.'); return 0; }
      const r = await withLock('store', async () => cleanStore(false));
      say(`Deleted ${r.removed} files, freed ${bytes(r.freed)}.`);
      return 0;
    }

    case 'config': {
      const cfg = readJson(configFile(), {} as any);
      if (args[0] === 'get' || !args[0]) { say(JSON.stringify({ storeDir: home(), ...cfg }, null, 2)); return 0; }
      if (args[0] === 'set' && args[1] === 'store-dir' && args[2]) {
        if (fs.existsSync(filesDir()) && fs.readdirSync(filesDir()).length) { say('The store already has files. Moving it is not supported yet; it would break the links.'); return 1; }
        writeJson(configFile(), { ...cfg, storeDir: path.resolve(args[2]) });
        say(`Store directory set to ${path.resolve(args[2])}`); return 0;
      }
      say('Usage: cn config get | set store-dir <path>'); return 1;
    }

    case 'doctor': {
      const ok = (b: boolean, t: string) => { say(`${b ? 'OK  ' : 'FAIL'} ${t}`); return b; };
      let all = true;
      const [major, minor] = process.versions.node.split('.').map(Number);
      all = ok(major > 22 || (major === 22 && minor >= 18), `Node.js ${process.version}`) && all;
      const npmv = await capture('npm', ['-v']);
      all = ok(!!npmv, `npm ${npmv || 'not found'}`) && all;
      fs.mkdirSync(filesDir(), { recursive: true });
      const a = path.join(home(), 'temp', `doctor-${process.pid}`), b = a + '-link';
      fs.mkdirSync(path.dirname(a), { recursive: true });
      fs.writeFileSync(a, 'x');
      let links = false;
      try { fs.linkSync(a, b); links = fs.statSync(a).nlink === 2; } catch {}
      fs.rmSync(a, { force: true }); fs.rmSync(b, { force: true });
      all = ok(links, `Hard links work in ${home()}`) && all;
      const root = findRoot();
      if (root) all = ok(sameVolume(root, home()), `This project is on the same drive as the store`) && all;
      const g = await globalRoot();
      if (g) ok(sameVolume(g, home()), `Global npm folder ${g} is on the same drive`);
      return all ? 0 : 1;
    }

    default:
      say(`Unknown command "${cmd}".\n`); say(HELP); return 1;
  }
}
