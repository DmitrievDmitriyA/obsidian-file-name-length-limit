// Ground-truth tests: verify the analyzer's rules against the *actual* filesystem
// this test process is running on, by really creating files and observing what the
// OS accepts, rejects, mangles, or collides.
//
// Platform mapping: win32 -> 'windows', linux -> 'linux', darwin -> 'ios' (APFS is
// the same filesystem family as iOS; the closest ground truth CI can provide).
// Android's shared-storage rules (MediaProvider) cannot be reproduced on hosted
// runners; its 255-byte name limit is shared with the linux run.
//
// Assertion direction:
// - If the FS rejects/mangles/collides, the analyzer MUST flag it (never miss a
//   real incompatibility).
// - If the FS accepts, the analyzer may still flag (deliberate conservatism, e.g.
//   Windows MAX_PATH with long paths enabled) — but on exact-match platforms
//   (windows on win32, linux on linux) name-level rules are checked strictly in
//   both directions.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzePath, findNameCollisions, PlatformKey } from './analyzer';

const platformKey: PlatformKey =
    process.platform === 'win32' ? 'windows' :
    process.platform === 'darwin' ? 'ios' :
    'linux';

// darwin approximates iOS, so only the must-flag direction is asserted there.
const exactPlatform = process.platform !== 'darwin';

let baseDir: string;
let caseCounter = 0;

beforeAll(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnll-gt-'));
});

afterAll(() => {
    try {
        fs.rmSync(baseDir, { recursive: true, force: true });
    } catch {
        // Leftovers in the temp dir are harmless.
    }
});

function freshDir(): string {
    const dir = path.join(baseDir, String(caseCounter++));
    fs.mkdirSync(dir);
    return dir;
}

type Observed = 'ok' | 'rejected' | 'mangled';

/** Try to create the file and check it round-trips with the exact same name. */
function observeCreate(name: string): { observed: Observed; dir: string } {
    const dir = freshDir();
    try {
        fs.writeFileSync(path.join(dir, name), 'x');
    } catch {
        return { observed: 'rejected', dir };
    }
    const listed = fs.readdirSync(dir);
    const ok = listed.length === 1 && listed[0] === name;
    return { observed: ok ? 'ok' : 'mangled', dir };
}

/** Create two names and observe whether the FS keeps them as distinct files. */
function observePair(a: string, b: string): 'coexist' | 'collide' | 'rejected' {
    const dir = freshDir();
    try {
        fs.writeFileSync(path.join(dir, a), 'a');
        fs.writeFileSync(path.join(dir, b), 'b');
    } catch {
        return 'rejected';
    }
    return fs.readdirSync(dir).length === 2 ? 'coexist' : 'collide';
}

/** Name-level issues only (the full-path rule is checked separately). */
function nameIssues(name: string): string[] {
    return analyzePath(name, [platformKey], 0)
        .filter(issue => !/full path/.test(issue.message))
        .map(issue => issue.message);
}

const BEL = String.fromCharCode(7);
const DEL = String.fromCharCode(127);

// win32ApiLayer: rules enforced by Win32 path normalization (Explorer, CreateFile
// with regular paths), not by NTFS itself. Node bypasses that layer via \\?\
// prefixed paths, so these names *create* fine here — but they still break
// Explorer and sync tooling, so the analyzer flags them on purpose. For such
// cases the strict accepts-means-no-flag direction is skipped on Windows.
const componentCases: { label: string; name: string; win32ApiLayer?: boolean }[] = [
    { label: '255-char ASCII name (valid everywhere)', name: 'a'.repeat(251) + '.md' },
    { label: '256-char ASCII name', name: 'a'.repeat(252) + '.md' },
    { label: 'emoji name: 263 UTF-16 units / 133 code points / 523 bytes', name: '🎉'.repeat(130) + '.md' },
    { label: 'accented name: 204 code points / 404 bytes', name: 'é'.repeat(200) + '.md' },
    { label: 'colon', name: 'a:b.md' },
    { label: 'less-than', name: 'a<b.md' },
    { label: 'greater-than', name: 'a>b.md' },
    { label: 'double quote', name: 'a"b.md' },
    { label: 'pipe', name: 'a|b.md' },
    { label: 'question mark', name: 'a?b.md' },
    { label: 'asterisk', name: 'a*b.md' },
    { label: 'backslash', name: 'a\\b.md' },
    { label: 'control character (BEL)', name: `a${BEL}b.md` },
    { label: 'DEL character', name: `a${DEL}b.md` },
    { label: 'reserved name CON', name: 'CON.md', win32ApiLayer: true },
    { label: 'reserved name lowercase con', name: 'con.md', win32ApiLayer: true },
    { label: 'reserved name COM1', name: 'COM1.md', win32ApiLayer: true },
    { label: 'trailing dot', name: 'trailing.md.', win32ApiLayer: true },
    { label: 'trailing space', name: 'trailing.md ', win32ApiLayer: true },
];

describe(`ground truth on ${process.platform} (checked as '${platformKey}')`, () => {
    for (const testCase of componentCases) {
        it(testCase.label, () => {
            const { observed } = observeCreate(testCase.name);
            const issues = nameIssues(testCase.name);
            if (observed !== 'ok') {
                expect(
                    issues.length,
                    `FS ${observed} this name but the analyzer does not flag it for ${platformKey}`,
                ).toBeGreaterThan(0);
            } else if (exactPlatform && !(testCase.win32ApiLayer && platformKey === 'windows')) {
                expect(
                    issues,
                    `FS accepts this name but the analyzer flags it for ${platformKey}`,
                ).toEqual([]);
            }
        });
    }

    it('case-only pair (Case.md vs case.md)', () => {
        const observed = observePair('Case.md', 'case.md');
        const flagged = findNameCollisions(['Case.md', 'case.md'], [platformKey]).length > 0;
        if (observed === 'collide') {
            expect(flagged, 'FS collides these names but the analyzer does not').toBe(true);
        } else if (observed === 'coexist' && exactPlatform) {
            expect(flagged, 'FS keeps these names distinct but the analyzer reports a collision').toBe(false);
        }
    });

    it('NFC/NFD pair (caf\\u00e9.md vs cafe\\u0301.md)', () => {
        const nfc = 'café.md';
        const nfd = 'café.md';
        const observed = observePair(nfc, nfd);
        const flagged = findNameCollisions([nfc, nfd], [platformKey]).length > 0;
        if (observed === 'collide') {
            expect(flagged, 'FS collides these names but the analyzer does not').toBe(true);
        } else if (observed === 'coexist' && exactPlatform) {
            expect(flagged, 'FS keeps these names distinct but the analyzer reports a collision').toBe(false);
        }
    });

    it('long absolute path (only the must-flag direction)', () => {
        // Build a nested relative path whose absolute length passes 280 chars,
        // using short components so only the total length is at stake.
        const dir = freshDir();
        const budget = dir.length + 1;
        const needed = Math.max(20, 285 - budget);
        const segments: string[] = [];
        let remaining = needed;
        while (remaining > 12) {
            segments.push('dddddddd'); // 8 + 1 separator
            remaining -= 9;
        }
        const relPath = [...segments, 'file.md'].join('/');

        let observedOk = true;
        try {
            fs.mkdirSync(path.join(dir, ...segments), { recursive: true });
            fs.writeFileSync(path.join(dir, ...segments, 'file.md'), 'x');
        } catch {
            observedOk = false;
        }

        if (!observedOk) {
            const flagged = analyzePath(relPath, [platformKey], budget)
                .some(issue => /full path/.test(issue.message));
            expect(flagged, 'FS rejected this path length but the analyzer does not flag it').toBe(true);
        }
        // If the FS accepts (e.g. long paths enabled), flagging is deliberate
        // conservatism for real-world Windows tooling — nothing to assert.
    });
});
