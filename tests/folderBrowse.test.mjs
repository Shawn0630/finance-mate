// Folder browser (src/folderBrowse.js): the Admin sync-folder
// picker lists the directories the app process can see, one level
// at a time, rooted at the app folder — and can never escape it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browseFolder, folderBrowseRoots, FOLDER_BROWSE_ROOT } from '../src/folderBrowse.js';

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-browse-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-browse-outside-'));
  fs.mkdirSync(path.join(root, 'data', 'sync'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'nested'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'README.md'), 'not a folder\n');
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'not a folder either\n');
  fs.mkdirSync(path.join(outside, 'secret'));
  fs.symlinkSync(outside, path.join(root, 'link-out'));
  fs.symlinkSync(path.join(root, 'src'), path.join(root, 'link-in'));
  return { root, outside };
}

test('browse root is the app folder', () => {
  assert.equal(FOLDER_BROWSE_ROOT, path.resolve('src', '..'));
});

test('no-path browse starts at the data folder when it exists', () => {
  const { root } = makeTree();
  const r = browseFolder(undefined, root);
  assert.equal(r.path, path.join(root, 'data'));
  assert.equal(r.parent, root);
  assert.deepEqual(r.roots, [
    { label: 'App folder', path: root },
    { label: 'Data folder', path: path.join(root, 'data') },
  ]);
  assert.deepEqual(r.dirs, [{ name: 'sync', path: path.join(root, 'data', 'sync') }]);
});

test('folderBrowseRoots drops the data root when there is no data folder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-browse-nodata-'));
  fs.mkdirSync(path.join(root, 'src'));
  assert.deepEqual(folderBrowseRoots(root), [{ label: 'App folder', path: root }]);
  const r = browseFolder(undefined, root);
  assert.equal(r.path, root);
  assert.equal(r.parent, null);
});

test('a browse lists subdirectories only, sorted, files excluded', () => {
  const { root } = makeTree();
  const r = browseFolder(root, root);
  assert.equal(r.path, root);
  assert.equal(r.parent, null);
  assert.deepEqual(r.dirs.map((d) => d.name), ['data', 'link-in', 'link-out', 'src', 'tests']);
  assert.ok(!r.dirs.some((d) => d.name === 'README.md'));
  const src = browseFolder(path.join(root, 'src'), root);
  assert.equal(src.parent, root);
  assert.deepEqual(src.dirs, [{ name: 'nested', path: path.join(root, 'src', 'nested') }]);
  assert.ok(!src.dirs.some((d) => d.name === 'app.js'));
});

test('traversal outside the root is rejected', () => {
  const { root, outside } = makeTree();
  for (const p of ['../outside', outside, path.join(root, '..', 'outside'), path.join(root, 'src', '..', '..', 'outside')]) {
    assert.throws(() => browseFolder(p, root), (e) => e.status === 400 && /outside the app folder/.test(e.message), p);
  }
});

test('a symlink inside the root pointing outside is rejected', () => {
  const { root } = makeTree();
  assert.throws(() => browseFolder(path.join(root, 'link-out'), root),
    (e) => e.status === 400 && /outside the app folder/.test(e.message));
});

test('a symlink to a folder inside the root is browsable', () => {
  const { root } = makeTree();
  const r = browseFolder(path.join(root, 'link-in'), root);
  assert.equal(r.path, path.join(root, 'link-in'));
  assert.equal(r.parent, root);
  assert.deepEqual(r.dirs, [{ name: 'nested', path: path.join(root, 'link-in', 'nested') }]);
});

test('bad paths are rejected', () => {
  const { root } = makeTree();
  assert.throws(() => browseFolder('', root), (e) => e.status === 400);
  assert.throws(() => browseFolder('   ', root), (e) => e.status === 400);
  assert.throws(() => browseFolder('~/data', root), (e) => e.status === 400 && /not expanded/.test(e.message));
  assert.throws(() => browseFolder(path.join(root, 'nope'), root), (e) => e.status === 400 && /not found/.test(e.message));
  assert.throws(() => browseFolder(path.join(root, 'README.md'), root), (e) => e.status === 400 && /not a folder/.test(e.message));
  assert.throws(() => browseFolder('relative/path', root), (e) => e.status === 400 && /outside the app folder/.test(e.message));
});
