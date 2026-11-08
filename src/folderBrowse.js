// Server-side folder browser for the Admin → Data iCloud sync
// folder picker: list the directories the app process itself can
// see, one level at a time, so the user can pick a folder in the UI
// instead of typing a path. Same pattern as the App Manager's
// picker (src/browse.js there). A web page cannot open the OS file
// dialog, and this has a matching virtue: folders that were never
// mounted into the container simply do not appear — the same-path
// mount requirement becomes visible instead of an error.
//
// The picker is rooted at the app folder (/app in Docker) and can
// never escape it: the requested path is resolved (symlinks
// included) and must stay inside the root. Only directory NAMES
// are ever listed — no file contents are read.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FOLDER_BROWSE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Quick-jump roots for the picker: always the app folder, plus its
// data folder when it is present on disk.
export function folderBrowseRoots(root = FOLDER_BROWSE_ROOT) {
  const roots = [{ label: 'App folder', path: path.resolve(root) }];
  const data = path.join(roots[0].path, 'data');
  try {
    if (fs.statSync(data).isDirectory()) roots.push({ label: 'Data folder', path: data });
  } catch {
    // no data folder (yet) — the app folder alone is enough
  }
  return roots;
}

// Where a path-less browse starts: the data folder when it exists,
// else the app folder.
function folderBrowseStart(root) {
  const data = path.join(root, 'data');
  try {
    if (fs.statSync(data).isDirectory()) return data;
  } catch {
    // not there (yet) — fall through to the app folder
  }
  return root;
}

function browseError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Browse one directory. `rawPath` undefined/null starts at the data
// folder (app folder when there is none); anything else must be a
// non-empty absolute path ("~" is rejected — nothing expands it).
// Returns: { path, parent, roots: [{ label, path }], dirs: [{ name, path }] }.
// Errors carry .status (400 bad path / 403 unreadable), in the same
// style as the registry errors.
export function browseFolder(rawPath, root = FOLDER_BROWSE_ROOT) {
  const base = path.resolve(root);
  let dir;
  if (rawPath == null) {
    dir = folderBrowseStart(base);
  } else {
    const raw = String(rawPath).trim();
    if (!raw) throw browseError('path must not be empty', 400);
    if (raw.startsWith('~')) {
      throw browseError(`path must be the full absolute path — "~" is not expanded (you entered: ${raw})`, 400);
    }
    dir = path.resolve(raw);
  }

  // Lexical containment first: reject anything that resolves
  // outside the root before touching the filesystem (covers ..,
  // absolute outside paths, and relative paths that land outside).
  const lexicalRel = path.relative(base, dir);
  if (lexicalRel === '..' || lexicalRel.startsWith(`..${path.sep}`)) {
    throw browseError('folder is outside the app folder', 400);
  }

  let stat;
  try {
    stat = fs.statSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT') throw browseError(`folder not found: ${dir}`, 400);
    throw e;
  }
  if (!stat.isDirectory()) throw browseError(`not a folder: ${dir}`, 400);

  // Never escape the root: resolve symlinks and require the real
  // path to stay inside the real root.
  let realDir;
  let realBase;
  try {
    realDir = fs.realpathSync(dir);
    realBase = fs.realpathSync(base);
  } catch {
    realDir = dir;
    realBase = base;
  }
  const rel = path.relative(realBase, realDir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`)) {
    throw browseError('folder is outside the app folder', 400);
  }

  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw browseError(`permission denied: cannot read folder ${dir}`, 403);
    }
    throw e;
  }
  const dirs = [];
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      // statSync follows symlinks: a symlink to a directory counts
      // as a directory; a broken symlink is skipped silently.
      if (fs.statSync(full).isDirectory()) dirs.push({ name, path: full });
    } catch {
      // unreadable or dangling entry — not a browsable folder
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));

  const parentDir = path.dirname(dir);
  return {
    path: dir,
    parent: realDir === realBase ? null : parentDir,
    roots: folderBrowseRoots(base),
    dirs,
  };
}
