# Testing guide

This plugin's correctness rests on claims about four different filesystems. This document explains how those claims are tested, why the tests are structured the way they are, and the pitfalls to know before touching them.

## Two test layers

| Layer | File | What it proves |
| --- | --- | --- |
| Unit tests | `analyzer.test.ts` | The analyzer implements the rules we encoded (length units, forbidden chars, reserved names, collisions). |
| Ground-truth tests | `groundtruth.test.ts` | The rules we encoded match what the OS **actually does** — by really creating files and observing the result. |

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

**MAX_PATH may not reproduce.** With long paths enabled (and via Node's `\\?\` handling), Windows accepts >260-char paths. The 260 limit is still real for Explorer and much tooling, so the analyzer keeps flagging it; the ground-truth test asserts only the must-flag direction for path length.

**NFC/NFD literals are invisible traps.** `café.md` (single `é`) and `café.md` (`e` + combining `́`) are byte-different but visually identical in editors, diffs, and terminal output. If you touch those tests, verify the encodings by code point:

```js
[...name].map(c => c.codePointAt(0).toString(16))
```

Don't retype the literals — an editor or IME will silently normalize them.

**Control characters don't survive copy-paste.** BEL/DEL test names are built with `String.fromCharCode(7)` / `(127)`, never embedded raw in source — raw control bytes render invisibly and break diff/grep tooling.

**Android is only partially testable.** Its restrictions come from the MediaProvider/FUSE layer over shared storage, which hosted runners can't reproduce. The Linux run covers the shared 255-byte name limit; the character rules and case-insensitivity rest on the AOSP sources cited in the `PLATFORMS` table in `analyzer.ts`.

**The macOS job doubles as an experiment.** The iOS rule counts 255 *code points* per name (per APFS documentation). The emoji test case (263 UTF-16 units / 133 code points) is accepted by APFS if that's right. If the macOS job ever fails on it, the documentation was wrong and the iOS limit should likely become UTF-8 bytes — update `PLATFORMS.ios` accordingly.

## Adding a rule: the checklist

1. Encode the rule in the `PLATFORMS` table in `analyzer.ts`, with a source citation in the comment block above it.
2. Add unit tests in `analyzer.test.ts` covering the platforms that do *and don't* have the rule.
3. Add a ground-truth case in `groundtruth.test.ts` so CI verifies it against the real filesystems.
4. Update the platform table in `README.md`.
