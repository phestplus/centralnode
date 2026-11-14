# CentralNode

[![npm](https://img.shields.io/npm/v/centralnode)](https://www.npmjs.com/package/centralnode) [![test](https://github.com/phestplus/centralnode/actions/workflows/test.yml/badge.svg)](https://github.com/phestplus/centralnode/actions/workflows/test.yml)

One package store for every Node.js project on the computer. Each package file is kept once, and every project uses that one copy.

Ten projects that all use React, Next.js and TypeScript keep **one** copy of those files on disk, not ten. Nothing changes for your teammates, your lockfiles or your tools.

## How it works

1. `cn install` runs normal `npm install`. npm still works out the dependency tree and writes `package.json` and `package-lock.json`, so teammates who use plain npm see no difference.
2. CentralNode then moves every file in `node_modules` into the central store. Each file is named by its SHA-256 and kept once. The store lives at:
   - Windows: `%LOCALAPPDATA%\CentralNode`
   - macOS: `~/Library/Application Support/CentralNode`
   - Linux: `$XDG_DATA_HOME/centralnode` (default `~/.local/share/centralnode`)
3. Each copy in the project is replaced by a **hard link** to the stored copy. The project's `node_modules` keeps its normal layout, so Node, TypeScript, Vite, Next.js, Jest, React Native and editors all work exactly as before. It takes no extra disk space.

## Install (30 seconds)

```sh
npm install -g centralnode
cn doctor
```

Or from source, with no dependencies to install:

```sh
git clone https://github.com/phestplus/centralnode
cd centralnode
npm link
cn doctor
```

Works on Windows (NTFS), macOS (APFS) and Linux (ext4, btrfs, xfs, and other file systems with hard links). Requires Node.js 22.18 or later.

The store must be on the same drive or file system as your projects, because hard links cannot cross file systems. `cn doctor` checks this. To keep the store somewhere else, run `cn config set store-dir <path>` before first use.

## Move your existing projects over

You do **not** need to delete `node_modules`. Run this inside a project:

```sh
cn link
```

Nothing is downloaded and the project keeps working throughout. Each file in its `node_modules` either becomes the stored copy (if the store doesn't have it yet) or is swapped for a link to the copy the store already has, which frees its space.

To do every project under a folder at once:

```sh
cn adopt C:\dev --dry-run   # list the projects and what their node_modules take now; changes nothing
cn adopt C:\dev             # link them all
cn store status             # measured savings
```

The first project you link mostly fills the store and frees little. The savings come from every project after it that uses the same packages.

From then on, use `cn install`, `cn add` and `cn remove` in place of the npm commands, so new packages are shared too. If you use plain npm by mistake, run `cn link` afterwards.

## Everyday commands

```sh
cn install                  # npm install, then share   (cn install --offline uses only the npm cache)
cn ci                       # npm ci, then share
cn add axios zod            # cn add -D typescript · cn add react@19 · cn add -g eslint
cn remove axios
cn run dev                  # any package.json script; extra arguments pass through: cn run dev -- --port 3001
cn status                   # how much of this project's node_modules really uses its own disk space
cn projects                 # registered projects
cn clean --dry-run          # store files no project uses any more
cn clean --yes
cn store verify             # finds a shared file that something changed in place
cn --help
```

`cn init` (run automatically by the commands above) writes `.centralnode/config.json` and adds `.centralnode/` to the checkout's own `.git/info/exclude`. It never touches `.gitignore`, so nothing shows up in Git.

## Questions

**Is `node_modules` still in the project?**
Yes, with the same folders and file names, so every tool finds its packages as usual. Its files are links to the central copy and take no space of their own.

**Two projects have the same package. What happens?**
- *Same version:* the files are identical, so they're stored once and both projects link to that one copy.
- *Different versions:* changed files are different content, so each project keeps its own. Files that didn't change between versions are still shared.

Each project always gets exactly the version its lockfile says.

**I delete one project. Does it break the other?**
No. The other project's link still holds the file. `cn clean` frees files no project uses any more.

**Explorer or Finder still shows `node_modules` at full size.**
They count a hard-linked file in full in every folder it appears in. The real figures are the drive's free space, `cn status` and `cn store status`. On macOS and Linux, a single `du -sh dir1 dir2` call counts each shared file once.

## Safety, and what to know

- **Files tools rewrite while running are never shared.** That covers these folders inside `node_modules`:
  - caches: `.cache`, `.vite`, `.next`, `.turbo`, `.parcel-cache`;
  - Android and native build output: `.gradle`, `.cxx`, `<pkg>/android/build`, `.expo`;
  - npm's own `.package-lock.json`.
- **Every swap is atomic.** A file is linked under a temporary name and then renamed into place, so it is always either the original or the shared copy. If a run is interrupted, the project still works fully, and the next `cn link` finishes the job.
- **Busy files are skipped.** Files held open by a running dev server or editor are left as they are and reported. Run `cn link` again later.
- **Only one CentralNode process writes to the store at a time.** Two projects can run `npm install` at once. The sharing step takes a store-wide lock.
- **npm's behaviour is unchanged.** npm itself does every install, so install scripts, `.npmrc`, logins, private registries and lockfiles behave as they always do.
- **`cn clean` only deletes store files that no project links to,** meaning a link count of 1.
- **Link limits are handled.** NTFS allows 1,023 links per file (ext4 65,000; APFS far more). Very common files such as licence texts move on to a second stored copy before reaching that limit.
- **Don't edit files inside `node_modules` by hand.** A shared file is the same file in every project that uses it, so an edit in one shows up in all of them. `cn store verify` reports any file that changed. If you use `patch-package`, run `cn install` after patching.
- **Untrusted projects.** Code from a project (its install scripts or the app itself) runs as you and could change shared files. Don't link projects you don't trust.
- **WSL.** Run `cn` inside WSL for projects in the Linux file system, and on Windows for projects on `C:\`. Each side keeps its own store. Projects in `\\wsl$\...` are skipped from Windows, because hard links can't reach them.

## Coming next

- Make store files read-only, so an accidental edit fails instead of spreading.
- `cn repair`: restore a changed file from npm's own download cache, with no internet needed.
- Never share the build output of native addons rebuilt in place.
- Clean up temporary files left by an interrupted run.
- A faster `cn store status` on very large stores.

## Tests

```sh
npm test
```

- **Store unit tests:** sharing, versions kept apart, cleaning, verification, folders that must stay private, and Git exclusion.
- **End-to-end test with the real npm registry:**
  - CommonJS and ESM apps run;
  - the same version is shared and different versions stay apart;
  - `add`, `add -D` and `remove` keep `package.json` in npm's format;
  - a teammate's plain `npm ci` on a clean copy gives a byte-identical lockfile.

GitHub Actions runs everything on Windows, macOS and Linux with Node 22 and 24, including installing the packed package and running it from `node_modules`.

## License

MIT
