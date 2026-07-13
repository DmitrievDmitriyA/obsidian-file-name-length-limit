import { describe, expect, it } from 'vitest';
import {
    analyzePath,
    buildReport,
    findCaseCollisions,
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

describe('findCaseCollisions', () => {
    it('detects case-only duplicates when a case-insensitive target is selected', () => {
        const collisions = findCaseCollisions(['Note.md', 'note.md', 'other.md'], ['windows']);
        expect(collisions).toHaveLength(1);
        expect(collisions[0].sort()).toEqual(['Note.md', 'note.md']);
    });

    it('finds nothing when only case-sensitive targets are selected', () => {
        expect(findCaseCollisions(['Note.md', 'note.md'], ['linux', 'android'])).toHaveLength(0);
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
        expect(report).toContain('## Case-only collisions');
        expect(report).toContain('`Note.md` vs `note.md`');
    });
});
