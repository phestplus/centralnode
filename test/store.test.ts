import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-test-'));
process.env.CENTRALNODE_HOME = path.join(tmp, 'home');
const { linkFolder, storeStatus, cleanStore, verifyStore, folderCost } = await import('../src/store.ts');
const { initProject, projects } = await import('../src/project.ts');

function project(name: string, files: Record<string, string>) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name }));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, 'node_modules', rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return root;
}
const ino = (f: string) => fs.statSync(f).ino;

test('identical files in two projects end up as one file on disk', async () => {
  const react = 'module.exports = "react 18";'.repeat(100);
  const a = project('a', { 'react/index.js': react, 'react/package.json': '{"name":"react","version":"18.3.1"}', 'only-a/index.js': 'a only' });
  const b = project('b', { 'react/index.js': react, 'react/package.json': '{"name":"react","version":"18.3.1"}' });
  const s1 = await linkFolder(path.join(a, 'node_modules'));
  assert.equal(s1.stored, 3);
  const s2 = await linkFolder(path.join(b, 'node_modules'));
  assert.equal(s2.linked, 2, 'b reuses both files');
  assert.equal(s2.savedBytes, react.length + '{"name":"react","version":"18.3.1"}'.length);
  assert.equal(ino(path.join(a, 'node_modules/react/index.js')), ino(path.join(b, 'node_modules/react/index.js')));
  assert.equal(fs.readFileSync(path.join(b, 'node_modules/react/index.js'), 'utf8'), react, 'content unchanged');
  const st = storeStatus();
  assert.equal(st.files, 3);
  assert.equal(st.saved, react.length + 35);
  assert.equal(folderCost(path.join(b, 'node_modules')).own, 0, 'b holds no bytes of its own');
});

test('different versions stay separate: each project keeps exactly its own files', async () => {
  const c = project('c', { 'react/index.js': 'module.exports = "react 19";' });
  await linkFolder(path.join(c, 'node_modules'));
  assert.equal(fs.readFileSync(path.join(c, 'node_modules/react/index.js'), 'utf8'), 'module.exports = "react 19";');
  assert.notEqual(ino(path.join(c, 'node_modules/react/index.js')), ino(path.join(tmp, 'a/node_modules/react/index.js')));
});

test('linking again is fast and changes nothing', async () => {
  const s = await linkFolder(path.join(tmp, 'b', 'node_modules'));
  assert.equal(s.already, 2);
  assert.equal(s.linked + s.stored, 0);
});

test('files tools rewrite while running are never shared', async () => {
  const d = project('d', { '.cache/babel/x.json': 'cache', '.package-lock.json': '{}', 'p/index.js': 'p', 'expo-x/android/build/out.bin': 'gradle' });
  const e = project('e', { '.cache/babel/x.json': 'cache', '.package-lock.json': '{}', 'p/index.js': 'p', 'expo-x/android/build/out.bin': 'gradle' });
  await linkFolder(path.join(d, 'node_modules')); await linkFolder(path.join(e, 'node_modules'));
  assert.notEqual(ino(path.join(d, 'node_modules/.cache/babel/x.json')), ino(path.join(e, 'node_modules/.cache/babel/x.json')));
  assert.notEqual(ino(path.join(d, 'node_modules/.package-lock.json')), ino(path.join(e, 'node_modules/.package-lock.json')));
  assert.notEqual(ino(path.join(d, 'node_modules/expo-x/android/build/out.bin')), ino(path.join(e, 'node_modules/expo-x/android/build/out.bin')));
  assert.equal(ino(path.join(d, 'node_modules/p/index.js')), ino(path.join(e, 'node_modules/p/index.js')));
});

test('deleting a project leaves its files for others, and clean frees only what nobody uses', async () => {
  fs.rmSync(path.join(tmp, 'c'), { recursive: true, force: true });
  const dry = cleanStore(true);
  assert.equal(dry.removed, 1, 'only react 19, used by the deleted project');
  assert.equal(cleanStore(false).removed, 1);
  assert.equal(fs.readFileSync(path.join(tmp, 'a/node_modules/react/index.js'), 'utf8').startsWith('module.exports = "react 18"'), true);
  assert.equal(cleanStore(true).removed, 0);
});

test('verify finds a shared file a tool changed in place', async () => {
  const f = path.join(tmp, 'a/node_modules/only-a/index.js');
  fs.writeFileSync(f, 'tampered');
  const bad: string[] = [];
  const r = await verifyStore((x) => bad.push(x));
  assert.equal(r.bad, 1);
});

test('init writes local config only and excludes it from Git, once', () => {
  const root = project('g', {});
  execFileSync('git', ['init', '-q'], { cwd: root });
  const r1 = initProject(root);
  assert.equal(r1.git, 'added');
  assert.equal(initProject(root).git, 'present');
  const ex = fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8');
  assert.equal(ex.split('\n').filter((l) => l === '.centralnode/').length, 1);
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).includes('.centralnode'), false);
  assert.ok(fs.existsSync(path.join(root, '.centralnode/config.json')));
  assert.equal(projects().filter((p) => p.path === path.resolve(root)).length, 1);
  const n = project('nogit', {});
  assert.equal(initProject(n).git, 'no-git');
});
