// Pure cross-platform file-name compatibility rules.
// This module intentionally has NO dependency on the `obsidian` API so it can be
// unit-tested in isolation. All Obsidian-specific glue lives in `main.ts`.

export type PlatformKey = 'windows' | 'linux' | 'android' | 'ios';

export interface PlatformSpec {
    label: string;
    /** Per-component cap in UTF-16 code units (how Windows/APFS count). */
    componentUnits: number;
    /** Per-component cap in UTF-8 bytes (how Linux/ext4 count). */
    componentBytes: number;
    /** Cap on the full absolute path, in UTF-16 units. */
    maxPathUnits: number;
    /** Whether the configurable device-root budget is added before the path check. */
    usesPrefixBudget: boolean;
    /** Characters forbidden in a name (besides control chars / NUL). */
    forbidden: string;
    forbidControl: boolean;
    forbidTrailingDotSpace: boolean;
    reservedNames: boolean;
    caseInsensitive: boolean;
}

export interface Issue {
    message: string;
    platforms: PlatformKey[];
}

const INF = Number.POSITIVE_INFINITY;

// The character sets below reflect what sync targets actually reject in practice:
// Android's shared storage (used by sync clients) inherits the FAT/Windows set,
// while APFS mainly rejects the path separator and colon.
export const PLATFORMS: Record<PlatformKey, PlatformSpec> = {
    windows: {
        label: 'Windows',
        componentUnits: 255,
        componentBytes: INF,
        maxPathUnits: 260,
        usesPrefixBudget: true,
        forbidden: '<>:"/\\|?*',
        forbidControl: true,
        forbidTrailingDotSpace: true,
        reservedNames: true,
        caseInsensitive: true,
    },
    linux: {
        label: 'Linux',
        componentUnits: INF,
        componentBytes: 255,
        maxPathUnits: 4096,
        usesPrefixBudget: false,
        forbidden: '/',
        forbidControl: true,
        forbidTrailingDotSpace: false,
        reservedNames: false,
        caseInsensitive: false,
    },
    android: {
        label: 'Android',
        componentUnits: INF,
        componentBytes: 255,
        maxPathUnits: 4096,
        usesPrefixBudget: false,
        forbidden: '<>:"/\\|?*',
        forbidControl: true,
        forbidTrailingDotSpace: true,
        reservedNames: false,
        caseInsensitive: false,
    },
    ios: {
        label: 'iOS',
        componentUnits: 255,
        componentBytes: INF,
        maxPathUnits: 1024,
        usesPrefixBudget: false,
        forbidden: ':/',
        forbidControl: true,
        forbidTrailingDotSpace: false,
        reservedNames: false,
        caseInsensitive: true,
    },
};

export const PLATFORM_ORDER: PlatformKey[] = ['windows', 'linux', 'android', 'ios'];

const WINDOWS_RESERVED = new Set<string>([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
}

export function labelList(keys: PlatformKey[]): string {
    return keys.map(key => PLATFORMS[key].label).join(', ');
}

function reservedBase(component: string): string {
    const dot = component.indexOf('.');
    const base = dot === -1 ? component : component.slice(0, dot);
    return base.trim().toUpperCase();
}

/**
 * Collect every cross-platform naming issue for a vault-relative path.
 * @param path vault-relative path, using `/` separators
 * @param targets the platforms to check against
 * @param windowsBudget characters to reserve for the device-root prefix Windows also counts
 */
export function analyzePath(path: string, targets: PlatformKey[], windowsBudget: number): Issue[] {
    if (targets.length === 0) {
        return [];
    }

    const issues: Issue[] = [];
    const components = path.split('/');

    for (const component of components) {
        const units = component.length;
        const bytes = utf8Bytes(component);

        const unitViolators = targets.filter(key => units > PLATFORMS[key].componentUnits);
        if (unitViolators.length > 0) {
            issues.push({
                message: `"${component}" is ${units} characters long (max 255 per name)`,
                platforms: unitViolators,
            });
        }

        const byteViolators = targets.filter(key => bytes > PLATFORMS[key].componentBytes);
        if (byteViolators.length > 0) {
            issues.push({
                message: `"${component}" is ${bytes} bytes long (max 255 per name)`,
                platforms: byteViolators,
            });
        }

        // Forbidden characters — grouped by the offending character.
        const forbiddenByChar = new Map<string, PlatformKey[]>();
        for (const key of targets) {
            const spec = PLATFORMS[key];
            for (const char of component) {
                const isControl = spec.forbidControl && char.charCodeAt(0) < 32;
                if (spec.forbidden.includes(char) || isControl) {
                    const shown = isControl ? `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}` : char;
                    const existing = forbiddenByChar.get(shown) ?? [];
                    if (!existing.includes(key)) {
                        existing.push(key);
                    }
                    forbiddenByChar.set(shown, existing);
                }
            }
        }
        for (const [char, keys] of forbiddenByChar) {
            issues.push({
                message: `"${component}" contains a forbidden character: ${char}`,
                platforms: keys,
            });
        }

        const trailingViolators = targets.filter(key =>
            PLATFORMS[key].forbidTrailingDotSpace && /[ .]$/.test(component));
        if (trailingViolators.length > 0) {
            issues.push({
                message: `"${component}" ends with a space or dot`,
                platforms: trailingViolators,
            });
        }

        const reservedViolators = targets.filter(key =>
            PLATFORMS[key].reservedNames && WINDOWS_RESERVED.has(reservedBase(component)));
        if (reservedViolators.length > 0) {
            issues.push({
                message: `"${component}" is a reserved name`,
                platforms: reservedViolators,
            });
        }
    }

    // Full absolute path length (Windows is the binding constraint).
    const pathViolators = targets.filter(key => {
        const spec = PLATFORMS[key];
        const budget = spec.usesPrefixBudget ? windowsBudget : 0;
        return budget + path.length > spec.maxPathUnits;
    });
    if (pathViolators.length > 0) {
        const total = windowsBudget + path.length;
        issues.push({
            message: `full path is ${path.length} characters (~${total} incl. the device root) — over the 260 limit`,
            platforms: pathViolators,
        });
    }

    return issues;
}

/** Detect paths that differ only by case, which collide on case-insensitive targets. */
export function findCaseCollisions(paths: string[], targets: PlatformKey[]): string[][] {
    const caseInsensitive = targets.some(key => PLATFORMS[key].caseInsensitive);
    if (!caseInsensitive) {
        return [];
    }
    const buckets = new Map<string, string[]>();
    for (const path of paths) {
        const key = path.toLowerCase();
        const bucket = buckets.get(key) ?? [];
        bucket.push(path);
        buckets.set(key, bucket);
    }
    return [...buckets.values()].filter(group => group.length > 1);
}

/** Render the vault-wide report as Markdown. */
export function buildReport(
    targets: PlatformKey[],
    affected: { path: string; issues: Issue[] }[],
    collisions: string[][],
): string {
    const lines: string[] = [];
    lines.push('# File name compatibility report');
    lines.push('');
    lines.push(`Targets: ${labelList(targets)}`);
    lines.push(`Files with issues: ${affected.length}`);
    lines.push('');

    for (const entry of affected) {
        lines.push(`## [[${entry.path}]] (${entry.issues.length})`);
        for (const issue of entry.issues) {
            lines.push(`- ${issue.message} — ${labelList(issue.platforms)}`);
        }
        lines.push('');
    }

    if (collisions.length > 0) {
        lines.push('## Case-only collisions');
        for (const group of collisions) {
            lines.push(`- ${group.map(p => `\`${p}\``).join(' vs ')}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
