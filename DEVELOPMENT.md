# Development & release guide

This document is for maintaining the plugin. For what the plugin does, see the [README](README.md).

## Project layout

| File | Purpose |
| --- | --- |
| `analyzer.ts` | Pure compatibility rules (name/byte length, forbidden chars, reserved names, path budget, collisions). **No `obsidian` import** — this is what the unit tests exercise. |
| `analyzer.test.ts` | Vitest unit tests for `analyzer.ts`. |
| `main.ts` | Obsidian glue: plugin lifecycle, settings tab, status bar, and vault I/O. Delegates all rules to `analyzer.ts`. |
| `styles.css` | Styles bundled with the plugin (e.g. the status-bar warning). |
| `manifest.json` | Plugin metadata Obsidian reads (`id`, `version`, `minAppVersion`, …). |
| `versions.json` | Maps each plugin version to the minimum Obsidian version. |
| `esbuild.config.mjs` | Build configuration. Bundles `main.ts` → `main.js`. |
| `version-bump.mjs` | Syncs `manifest.json`/`versions.json` when `npm version` runs. |
| `main.js` | **Build output.** Git-ignored; shipped only via GitHub releases. |

## Prerequisites

- Node.js 18+ and npm.
- An Obsidian vault to test in (a throwaway one is ideal).

## First-time setup

```bash
npm install
```

## Develop

Start the watcher — it rebuilds `main.js` on every save:

```bash
npm run dev
```

To see changes in Obsidian you need the three runtime files (`main.js`, `manifest.json`, `styles.css`) inside your test vault at:

```
<YourVault>/.obsidian/plugins/file-name-length-limit/
```

Two ways to get them there:

- **Symlink once** (recommended) so builds land in the vault automatically. In an elevated PowerShell:

  ```powershell
  $dest = "C:\path\to\TestVault\.obsidian\plugins\file-name-length-limit"
  New-Item -ItemType Directory -Force $dest
  foreach ($f in "main.js","manifest.json","styles.css") {
    New-Item -ItemType SymbolicLink -Path "$dest\$f" -Target "$PWD\$f"
  }
  ```

- **Copy** the three files manually after each build.

After a rebuild, reload the plugin: toggle it off/on under **Settings → Community plugins**, or press **Ctrl/Cmd+R**. Installing the community **Hot Reload** plugin in the test vault makes it auto-reload on rebuild.

> The plugin `id` in `manifest.json` (`file-name-length-limit`) must match the plugin folder name. Avoid having a second folder with the same `id` — Obsidian will load only one and the result is confusing.

## Build & type-check

```bash
npm run build
```

This runs `tsc -noEmit -skipLibCheck` (type-check) followed by a production esbuild bundle. CI and releases use the same command, so a clean `npm run build` is the bar for merging.

## Test

The compatibility rules live in `analyzer.ts` with no `obsidian` dependency, so they run in plain Node:

```bash
npm test          # run once (used by CI)
npm run test:watch # re-run on change while developing
```

Add a case to `analyzer.test.ts` whenever you change a platform rule. Keep new rule logic in `analyzer.ts` (testable) rather than `main.ts` (needs Obsidian).

## Continuous integration

Two GitHub Actions workflows run automatically:

- [`ci.yml`](.github/workflows/ci.yml) — on every push to `main` and every pull request: type-check, build, and test. This is the gate for merging.
- [`compat.yml`](.github/workflows/compat.yml) — weekly (and on demand): rebuilds against `obsidian@latest` to catch upstream API changes, opening an issue if the build breaks. Note that scheduled workflows only run from the default branch and GitHub disables them after 60 days of repo inactivity.

## Release

Obsidian installs community plugins from **GitHub releases** whose tag exactly equals the `version` in `manifest.json` (no `v` prefix), with `main.js`, `manifest.json`, and `styles.css` attached as assets.

### 1. Bump the version

`minAppVersion` lives in `manifest.json`; update it first if you rely on a newer Obsidian API. Then:

```bash
npm version patch   # or: minor / major
```

`npm version` writes the new number to `package.json`, runs `version-bump.mjs` (which updates `manifest.json` and adds a `versions.json` entry), and commits + tags. If you prefer to bump the three files by hand, do so and create the matching tag yourself.

### 2. Push

```bash
git push && git push --tags
```

### 3. Publish the release

The GitHub Actions workflow in [`.github/workflows/release.yml`](.github/workflows/release.yml) triggers on the pushed tag, builds the plugin, and creates a draft/published release with the three assets attached. Review it under the repo's **Releases** tab and publish if it's a draft.

To do it manually instead:

```bash
npm run build
gh release create <version> --title "<version>" main.js manifest.json styles.css
```

## Getting listed in Community plugins

A plugin appears in Obsidian's in-app browser only after it's added to the official [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) list. Do this **once**:

1. Make sure the repo is public and has at least one release (see above), plus a root `README.md`, `LICENSE`, and `manifest.json`.
2. Fork `obsidianmd/obsidian-releases` and add an entry to `community-plugins.json`:

   ```json
   {
     "id": "file-name-length-limit",
     "name": "File name length limit",
     "author": "Dmitrii Dmitriev",
     "description": "Keeps file names compatible across Windows, Linux, Android, and iOS.",
     "repo": "DmitrievDmitriyA/obsidian-file-name-length-limit"
   }
   ```

3. Open a pull request. An automated bot checks your repo against the [plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines); a maintainer then reviews it. Address any feedback on this repo and push a new release if needed.

Once merged, users can find the plugin via **Settings → Community plugins → Browse**. Subsequent updates ship by simply publishing a new GitHub release — no further PR to `obsidian-releases` is required.

## Useful references

- [Build a plugin](https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin)
- [Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin)
- [Plugin guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)
