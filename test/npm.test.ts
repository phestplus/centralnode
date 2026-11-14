import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

// End to end with the real npm and registry. Proves the three things the plan says must be proven first.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-npm-'));
const env = { ...process.env, CENTRALNODE_HOME: path.join(tmp, 'home') };
const cn = (args: string, cwd: string) => execSync(`node "${path.resolve('bin/cn.js')}" ${args}`, { cwd, env, encoding: 'utf8' });
const mk = (name: string, deps: Record<string, string>, main: string, type = 'commonjs') => {
  const d = path.join(tmp, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, version: '1.0.0', type, dependencies: deps, scripts: { start: 'node index.js' } }, null, 2));
  fs.writeFileSync(path.join(d, 'index.js'), main);
  return d;
};
const ino = (f: string) => fs.statSync(f).ino;

test('real npm projects share the store, keep their own versions, and stay plain npm projects', { timeout: 1500000 }, () => {
  const a = mk('app-a', { 'is-number': '7.0.0', ms: '2.1.3' }, "const n=require('is-number');const ms=require('ms');console.log('A', n(5), ms('1m'), require('is-number/package.json').version)");
  const b = mk('app-b', { 'is-number': '7.0.0', ms: '2.1.2' }, "import n from 'is-number';import ms from 'ms';import {createRequire} from 'node:module';const r=createRequire(import.meta.url);console.log('B', n(5), ms('1m'), r('ms/package.json').version)", 'module');
  cn('install --no-audit --no-fund', a);
  const out = cn('install --no-audit --no-fund', b);
  assert.match(out, /now shared/);

  // 1. Both apps run (CommonJS and ESM).
  assert.match(execSync('node index.js', { cwd: a, encoding: 'utf8' }), /A true 60000 7\.0\.0/);
  assert.match(execSync('node index.js', { cwd: b, encoding: 'utf8' }), /B true 60000 2\.1\.2/);
  assert.match(cn('run start', a), /A true/);

  // 2. Same version: one file on disk. Different version: kept apart.
  assert.equal(ino(path.join(a, 'node_modules/is-number/index.js')), ino(path.join(b, 'node_modules/is-number/index.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'node_modules/ms/package.json'), 'utf8')).version, '2.1.3');
  assert.equal(JSON.parse(fs.readFileSync(path.join(b, 'node_modules/ms/package.json'), 'utf8')).version, '2.1.2');

  // 3. A teammate without CentralNode: plain npm ci on a clean copy gives the same lockfile and a working app.
  const lock = fs.readFileSync(path.join(a, 'package-lock.json'), 'utf8');
  const mate = path.join(tmp, 'teammate');
  fs.mkdirSync(mate);
  for (const f of ['package.json', 'package-lock.json', 'index.js']) fs.copyFileSync(path.join(a, f), path.join(mate, f));
  execSync('npm ci --no-audit --no-fund --no-update-notifier', { cwd: mate, stdio: 'ignore' });
  assert.equal(fs.readFileSync(path.join(mate, 'package-lock.json'), 'utf8'), lock);
  assert.match(execSync('node index.js', { cwd: mate, encoding: 'utf8' }), /A true/);

  // add / add -D / remove keep package.json in npm's own format.
  cn('add -D is-odd@3.0.1 --no-audit --no-fund', a);
  const pkg = JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8'));
  assert.equal(pkg.devDependencies['is-odd'], '^3.0.1');
  cn('remove is-odd --no-audit --no-fund', a);
  assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'package.json'), 'utf8')).devDependencies?.['is-odd'], undefined);

  // Reinstalling after deleting node_modules relinks everything, and status shows no bytes of its own.
  fs.rmSync(path.join(b, 'node_modules'), { recursive: true, force: true });
  cn('install --no-audit --no-fund', b);
  assert.match(cn('status', b), /0 B not shared/);
  assert.match(cn('store status', a), /Saved: /);
});
