import { describe, expect, it } from 'vitest';
import {
    analyzePath,
    buildReport,
    findNameCollisions,
    PlatformKey,
    utf8Bytes,
} from './analyzer';

const ALL: PlatformKey[] = ['windows', 'linux', 'android', 'ios'];
const NO_BUDGET = 0;

/** Platforms flagged for the first issue whose message matches. */
function platformsFor(path: string, targets: PlatformKey[], budget: number, match: RegExp): PlatformKey[] {
    const issue = analyzePath(path, targets, budget).find(i => match.test(i.message));
    return issue ? issue.platforms : [];
}

describe('utf8Bytes', () => {
    it('counts bytes, not UTF-16 units', () => {
        expect(utf8Bytes('cafe')).toBe(4);
        expect(utf8Bytes('café')).toBe(5); // é is 2 bytes
        expect(utf8Bytes('🎉')).toBe(4); // 2 UTF-16 units, 4 bytes
    });
});

describe('analyzePath — name length', () => {
    it('reports nothing for a short ASCII name', () => {
        expect(analyzePath('Notes/Daily.md', ALL, NO_BUDGET)).toHaveLength(0);
    });

    it('flags a byte-limited emoji name on Linux/Android but not Windows/iOS', () => {
        // 255 UTF-16 units, 257 UTF-8 bytes: at the char limit, over the byte limit.
        const name = 'x'.repeat(250) + '🎉' + '.md';
        expect(name.length).toBeLessThanOrEqual(255);
        expect(utf8Bytes(name)).toBeGreaterThan(255);

        const byteFlag = platformsFor(name, ALL, NO_BUDGET, /bytes long/);
        expect(byteFlag.sort()).toEqual(['android', 'linux']);
        // No character-count issue should be raised.
        expect(platformsFor(name, ALL, NO_BUDGET, /characters long/)).toHaveLength(0);
    });

    it('flags a 300-char ASCII name on Windows/iOS by characters and Linux/Android by bytes', () => {
        const name = 'a'.repeat(300) + '.md';
        expect(platformsFor(name, ALL, NO_BUDGET, /characters long/).sort()).toEqual(['ios', 'windows']);
        expect(platformsFor(name, ALL, NO_BUDGET, /bytes long/).sort()).toEqual(['android', 'linux']);
    });

    it('flags an emoji-heavy name over 255 UTF-16 units on Windows AND iOS (APFS counts units, verified empirically)', () => {
        // 130 emoji: 263 UTF-16 units, 133 code points, 523 bytes. Real APFS rejects
        // this name (ground-truth CI), so iOS is measured in UTF-16 units like Windows.
        const name = '🎉'.repeat(130) + '.md';
        expect(platformsFor(name, ALL, NO_BUDGET, /characters long/).sort()).toEqual(['ios', 'windows']);
        expect(platformsFor(name, ALL, NO_BUDGET, /bytes long/).sort()).toEqual(['android', 'linux']);
    });
});

describe('analyzePath — characters and names', () => {
    it('flags a colon on Windows, Android, and iOS but not Linux', () => {
        const flagged = platformsFor('Notes/12:00 meeting.md', ALL, NO_BUDGET, /forbidden character/);
        expect(flagged.sort()).toEqual(['android', 'ios', 'windows']);
    });

    it('flags a reserved name only on Windows', () => {
        expect(platformsFor('CON.md', ALL, NO_BUDGET, /reserved name/)).toEqual(['windows']);
        // A non-reserved lookalike is fine.
        expect(analyzePath('CONTENTS.md', ALL, NO_BUDGET)).toHaveLength(0);
    });

    it('flags a folder name with a trailing space on Windows/Android only', () => {
        // The space must end the path component; `draft .md` ends in "d" and is fine.
        const flagged = platformsFor('My folder /note.md', ALL, NO_BUDGET, /space or dot/);
        expect(flagged.sort()).toEqual(['android', 'windows']);
    });

    it('reports each forbidden character separately', () => {
        const issues = analyzePath('a<b>c.md', ALL, NO_BUDGET).filter(i => /forbidden character/.test(i.message));
        expect(issues).toHaveLength(2);
    });

    it('flags control characters on Windows/Android/iOS but not Linux (ext4 allows them)', () => {
        const flagged = platformsFor('bell\x07.md', ALL, NO_BUDGET, /forbidden character/);
        expect(flagged.sort()).toEqual(['android', 'ios', 'windows']);
    });

    it('flags DEL (0x7f) on Android only, shown as an escape', () => {
        const issues = analyzePath('del\x7f.md', ALL, NO_BUDGET).filter(i => /forbidden character/.test(i.message));
        expect(issues).toHaveLength(1);
        expect(issues[0].platforms).toEqual(['android']);
        expect(issues[0].message).toContain('\\x7f');
    });
});

describe('analyzePath — full path length', () => {
    const longPath = 'folder/' + 'a'.repeat(250) + '/note.md'; // ~265 chars, each name <255

    it('flags the Windows 260 limit and adds the device-root budget', () => {
        expect(platformsFor(longPath, ['windows'], 90, /full path/)).toEqual(['windows']);
    });

    it('does not flag Linux, whose path limit is far higher', () => {
        expect(platformsFor(longPath, ['linux'], 90, /full path/)).toHaveLength(0);
    });

    it('respects the budget: a larger budget can push a shorter path over', () => {
        const path = 'a'.repeat(200) + '.md'; // 203 chars
        expect(platformsFor(path, ['windows'], 30, /full path/)).toHaveLength(0);
        expect(platformsFor(path, ['windows'], 80, /full path/)).toEqual(['windows']);
    });

    it('applies the device-root budget to Windows only', () => {
        // Even an absurd budget must not push other platforms over their limits.
        expect(platformsFor('a.md', ['linux', 'android', 'ios'], 5000, /full path/)).toHaveLength(0);
        expect(platformsFor('a.md', ['windows'], 5000, /full path/)).toEqual(['windows']);
    });
});

describe('analyzePath — target selection', () => {
    it('returns no issues when no platforms are selected', () => {
        expect(analyzePath('CON.md', [], NO_BUDGET)).toHaveLength(0);
    });

    it('only reports issues for the selected platforms', () => {
        // Reserved names are a Windows-only rule, so selecting only Linux ignores it.
        expect(analyzePath('CON.md', ['linux'], NO_BUDGET)).toHaveLength(0);
    });
});

describe('findNameCollisions', () => {
    it('detects case-only duplicates when a case-insensitive target is selected', () => {
        const collisions = findNameCollisions(['Note.md', 'note.md', 'other.md'], ['windows']);
        expect(collisions).toHaveLength(1);
        expect(collisions[0].sort()).toEqual(['Note.md', 'note.md']);
    });

    it('detects case-only duplicates on Android (shared storage is case-insensitive)', () => {
        expect(findNameCollisions(['Note.md', 'note.md'], ['android'])).toHaveLength(1);
    });

    it('finds nothing when only case- and normalization-sensitive targets are selected', () => {
        expect(findNameCollisions(['Note.md', 'note.md'], ['linux'])).toHaveLength(0);
    });

    it('detects NFC/NFD normalization duplicates on iOS', () => {
        const nfc = 'café.md'; // e-acute as a single code point
        const nfd = 'café.md'; // e + combining acute accent
        expect(findNameCollisions([nfc, nfd], ['ios'])).toHaveLength(1);
        // Case-insensitive but normalization-sensitive targets do not collide these.
        expect(findNameCollisions([nfc, nfd], ['android'])).toHaveLength(0);
        expect(findNameCollisions([nfc, nfd], ['linux'])).toHaveLength(0);
    });
});

describe('buildReport', () => {
    it('includes targets, files, issues, and collisions', () => {
        const report = buildReport(
            ['windows', 'linux'],
            [{ path: 'a/b.md', issues: [{ message: 'too long', platforms: ['linux'] }] }],
            [['Note.md', 'note.md']],
        );
        expect(report).toContain('Targets: Windows, Linux');
        expect(report).toContain('## [[a/b.md]] (1)');
        expect(report).toContain('- too long — Linux');
        expect(report).toContain('## Colliding names (differ only by case or Unicode normalization)');
        expect(report).toContain('`Note.md` vs `note.md`');
    });
});
