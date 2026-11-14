# CentralNode

One package store for every Node.js project on the computer. Each package file is kept once, and every project uses that one copy.

Ten projects that all use React, Next.js and TypeScript keep **one** copy of those files on disk, not ten.

## How it works

- `cn install` runs normal `npm install`. npm still decides the dependency tree and writes `package.json` and `package-lock.json`, so teammates who use plain npm see no difference.
- CentralNode then moves every file in `node_modules` into the central store. Each file is named by its SHA-256 and kept once. The store lives at:
  - Windows: `%LOCALAPPDATA%\CentralNode`
  - macOS: `~/Library/Application Support/CentralNode`
  - Linux: `$XDG_DATA_HOME/centralnode` (default `~/.local/share/centralnode`)
- Each copy in the project is replaced by a **hard link** to the stored copy. The project's `node_modules` keeps its usual layout, so Node, TypeScript, Vite, Next.js, Jest and editors all work as before. It takes no extra disk space.
- A file that two projects use in the same version is one file on disk. Different versions stay separate, because they are different files.

## Install (30 seconds)

```sh
npm install -g centralnode
cn doctor
```

Or from source:

```sh
git clone https://github.com/phestplus/centralnode
cd centralnode
npm link        # puts "cn" on your PATH. No dependencies to install.
cn doctor
```

Works on Windows (NTFS), macOS (APFS) and Linux (ext4, btrfs, xfs, and other file systems with hard links). Requires Node.js 22.18 or later.

The store must be on the same drive or file system as your projects, because hard links cannot cross file systems. `cn doctor` checks this. To keep the store elsewhere, use `cn config set store-dir <path>`.

WSL: run `cn` inside WSL for projects in the Linux file system, and on Windows for projects on `C:\`. Each side keeps its own store.

## Use

```powershell
cn adopt C:\dev --dry-run   # (or ~/code) what your node_modules folders take today
cn adopt C:\dev             # share all of them. Nothing is downloaded again.
cn store status             # measured savings

cn install                  # in any project: npm install + share
cn add axios zod            # cn add -D typescript · cn add react@19 · cn add -g eslint
cn remove axios
cn run dev
cn status                   # how much of this project's node_modules is really on disk
cn clean --dry-run          # store files no project uses any more
cn clean --yes
cn store verify             # finds a shared file a tool changed in place
```

`cn init` writes `.centralnode/config.json` and adds `.centralnode/` to `.git/info/exclude`. It never touches `.gitignore`, so nothing shows up in Git.

## Safety

- Files tools rewrite while running are never shared: `.cache`, `.vite`, `.next`, `.turbo` inside `node_modules`, and npm's own `.package-lock.json`.
- Replacing a file with a link is atomic: link to a temporary name, then rename. If anything fails, the original file stays.
- Files in use by a running dev server or editor are skipped and reported. Run `cn link` again later.
- `cn clean` deletes only store files that no project links to (link count 1). Deleting a project's folder frees its share on the next clean.
- NTFS allows 1,023 links per file (ext4 65,000; APFS far more). Very common files such as licence texts move on to a second copy before reaching that limit.
- One rule to know: **don't edit files inside `node_modules` by hand**. A shared file is the same file in every project that uses it. `cn store verify` reports any file that changed. `patch-package` users should run `cn install` after patching, because npm rewrites patched files as new files.

## File browsers show the old size

Windows Explorer and Finder count a hard-linked file in full in every folder it appears in. So `node_modules` still looks just as big there, even though the space is used only once. On macOS and Linux, a single `du -sh dir1 dir2` call counts each shared file once. Free space on the drive is the real figure, and so are `cn store status` and `cn status`.

## Tests

```powershell
npm test
```

There are two parts:
- Unit tests for the store: sharing, versions kept apart, cleaning, checking, Git exclusion.
- An end-to-end test with the real npm registry: CommonJS and ESM apps run, the same version is shared, different versions stay apart, and a teammate's `npm ci` on a clean copy gives a byte-identical lockfile.

## License

MIT
