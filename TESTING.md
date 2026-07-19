# Testing guide

This plugin's correctness rests on claims about four different filesystems. This document explains how those claims are tested, why the tests are structured the way they are, and the pitfalls to know before touching them.

## Three test layers

| Layer | File | What it proves |
| --- | --- | --- |
| Unit tests | `analyzer.test.ts` | The analyzer implements the rules we encoded (length units, forbidden chars, reserved names, collisions). |
| Ground-truth tests | `groundtruth.test.ts` | The rules we encoded match what the OS **actually does** — by really creating files and observing the result. |
| Integration tests | `main.test.ts` | The Obsidian glue works: settings loading/migration, budget auto-detection, report creation/overwrite, notices. Runs against a mocked `obsidian` module (`obsidian-mock.ts`, wired via `vitest.config.ts`). |

Both run with Vitest:

```bash
npm test                                # everything
npx vitest run groundtruth.test.ts      # ground truth only (tests the OS you're on)
```

All rule logic lives in `analyzer.ts`, which deliberately has **no `obsidian` import** so it runs in plain Node. Keep it that way: new rules go in `analyzer.ts` + tests, not in `main.ts`.

## How ground truth works

`groundtruth.test.ts` maps the running OS to a platform key — win32 → `windows`, linux → `linux`, darwin → `ios` (APFS is the same filesystem family as iOS; the closest ground truth CI can offer). It then creates edge-case names in a temp directory and classifies the outcome:

- **rejected** — the create call threw;
- **mangled** — the create succeeded but the name on disk differs (e.g. Windows stripping a trailing dot);
- **collide / coexist** — for name pairs (case-only, NFC/NFD).

### The directional assertion (the important design decision)

- If the OS **rejects, mangles, or collides** → the analyzer **must flag it**. A miss here is a real bug: the plugin would stay silent about a name that breaks on a user's device.
- If the OS **accepts** → the analyzer **may still flag it**. Some limits are enforced above the filesystem (see below), so being stricter than the raw FS is often deliberate. Strict accepts-means-no-flag checking is applied only on exact platforms (Windows on win32, Linux on linux) for name-level rules.

This asymmetry is what keeps the suite stable across OS versions and runner quirks while still catching every dangerous rule error.

### CI

`.github/workflows/ground-truth.yml` runs the suite on **windows-latest (NTFS), ubuntu-latest (ext4), and macos-latest (APFS)**:

- whenever `analyzer.ts` or the ground-truth suite changes;
- monthly (catches behavior drift in OS/runner images);
- on demand via workflow dispatch.

## Known subtleties — read before "fixing" a surprising result

**Node bypasses the Win32 naming layer.** Node/libuv converts paths to `\\?\` form internally, which skips Win32 path normalization. Consequence: `CON.md`, `COM1.md`, and names with trailing dots/spaces **create successfully** on NTFS from Node — yet Explorer and most sync tools still reject them, so the analyzer flags them on purpose. These cases are marked `win32ApiLayer: true` in the suite and exempted from the strict accepts-means-no-flag direction. (The first-ever run of this suite "failed" 5 cases exactly this way; it was the harness discovering this, not a rules bug.)

**MAX_PATH may not reproduce — it's per-application, not one wall.** An app handles >260-char paths only if the `LongPathsEnabled` registry switch is on (default: **off**) *and* the app opts in via its manifest (or uses `\\?\` paths itself, like Node/Obsidian). Measured on a Windows 11 (build 26200) machine with `LongPathsEnabled=1`: Explorer copy, `cmd.exe copy`, `Compress-Archive`, and `tar` all handled a 389-char path fine — while on the same machine `git add` failed with "Filename too long", because Git for Windows keeps its own limit unless `core.longpaths=true` (off by default). Since the registry default is off on other machines and opt-in is per-app, the analyzer keeps flagging >260 for portability; the ground-truth test asserts only the must-flag direction for path length.

**NFC/NFD literals are invisible traps.** `café.md` (single `é`) and `café.md` (`e` + combining `́`) are byte-different but visually identical in editors, diffs, and terminal output. If you touch those tests, verify the encodings by code point:

```js
[...name].map(c => c.codePointAt(0).toString(16))
```

Don't retype the literals — an editor or IME will silently normalize them.

**Control characters don't survive copy-paste.** BEL/DEL test names are built with `String.fromCharCode(7)` / `(127)`, never embedded raw in source — raw control bytes render invisibly and break diff/grep tooling.

**Android is only partially testable.** Its restrictions come from the MediaProvider/FUSE layer over shared storage, which hosted runners can't reproduce. The Linux run covers the shared 255-byte name limit; the character rules and case-insensitivity rest on the AOSP sources cited in the `PLATFORMS` table in `analyzer.ts`.

**The APFS name-length unit was settled empirically.** Documentation claims APFS caps names at 255 UTF-8 *characters* (code points). The very first macOS ground-truth run disproved that: APFS **rejected** a 263-unit / 133-code-point / 523-byte emoji name while **accepting** a 204-unit / 404-byte accented name. The only simple measure consistent with both observations is **255 UTF-16 units** — so `PLATFORMS.ios` counts units, same as Windows, and the code-point measure was removed. If a future macOS run fails a length case, re-derive the unit from the observations before touching the rule.

## Testing frontier (candidates, not built)

Ideas evaluated but not implemented yet, roughly by effort:

- **Android emulator job** (`workflow_dispatch`-only) — the one way to truly test the MediaProvider layer instead of relying on AOSP sources; slow (~10 min per run) and the flakiest of these options.
- **exFAT loopback mount on the Linux runner** — mount an exFAT image and run the suite against it: real SD-card semantics for the FAT character set.
- **Case-sensitive APFS sparse image** (`hdiutil`) on macOS — iOS's data volume is actually the case-*sensitive* APFS variant, while the macOS runner's default volume is case-insensitive; this would sharpen the iOS collision claims.
- **Sync-service rule sets** (iCloud's leading-dot exclusion, OneDrive's extra reserved names, Dropbox/Obsidian Sync quirks) — arguably more valuable than any of the above for real users, but it's a feature (new platform toggles in `PLATFORMS`), not just tests.

## Adding a rule: the checklist

1. Encode the rule in the `PLATFORMS` table in `analyzer.ts`, with a source citation in the comment block above it.
2. Add unit tests in `analyzer.test.ts` covering the platforms that do *and don't* have the rule.
3. Add a ground-truth case in `groundtruth.test.ts` so CI verifies it against the real filesystems.
4. Update the platform table in `README.md`.
