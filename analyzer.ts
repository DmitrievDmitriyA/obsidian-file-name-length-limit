// Pure cross-platform file-name compatibility rules.
// This module intentionally has NO dependency on the `obsidian` API so it can be
// unit-tested in isolation. All Obsidian-specific glue lives in `main.ts`.

export type PlatformKey = 'windows' | 'linux' | 'android' | 'ios';

export interface PlatformSpec {
    label: string;
    /** Per-component cap in UTF-16 code units (how Windows/NTFS and APFS count). */
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
    /** APFS treats NFC/NFD spellings of the same name as identical. */
    normalizationInsensitive: boolean;
}

export interface Issue {
    message: string;
    platforms: PlatformKey[];
}

const INF = Number.POSITIVE_INFINITY;

// Sources for these rules:
// - Windows: Microsoft file-naming documentation (NTFS counts UTF-16 units; MAX_PATH 260).
// - Linux: ext4 NAME_MAX/PATH_MAX; the filesystem itself only rejects '/' and NUL.
// - Android: shared storage (/storage/emulated/0) enforces the FAT character set,
//   a 255-UTF-8-byte name cap (MediaProvider MAX_FILENAME_BYTES), rejects control
//   chars and DEL, and is case-insensitive per AOSP's storage documentation.
// - iOS: measured empirically on real APFS (ground-truth CI on macOS): a name of
//   263 UTF-16 units / 133 code points / 523 bytes is REJECTED while 204 units /
//   404 bytes is ACCEPTED — so the enforced limit matches 255 UTF-16 units, not
//   code points (as some documentation claims) and not UTF-8 bytes. APFS is
//   case- and normalization-insensitive.
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
        normalizationInsensitive: false,
    },
    linux: {
        label: 'Linux',
        componentUnits: INF,
        componentBytes: 255,
        maxPathUnits: 4096,
        usesPrefixBudget: false,
        forbidden: '/',
        forbidControl: false,
        forbidTrailingDotSpace: false,
        reservedNames: false,
        caseInsensitive: false,
        normalizationInsensitive: false,
    },
    android: {
        label: 'Android',
        componentUnits: INF,
        componentBytes: 255,
        maxPathUnits: 4096,
        usesPrefixBudget: false,
        forbidden: '<>:"/\\|?*\x7f',
        forbidControl: true,
        forbidTrailingDotSpace: true,
        reservedNames: false,
        caseInsensitive: true,
        normalizationInsensitive: false,
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
        normalizationInsensitive: true,
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

        // Each platform counts name length in its own unit. Violations that end up
        // with the same displayed count are merged into one issue.
        const measures = [
            { value: units, unit: 'characters', violators: targets.filter(key => units > PLATFORMS[key].componentUnits) },
            { value: bytes, unit: 'bytes', violators: targets.filter(key => bytes > PLATFORMS[key].componentBytes) },
        ];
        const lengthGroups = new Map<string, { value: number; unit: string; platforms: PlatformKey[] }>();
        for (const measure of measures) {
            if (measure.violators.length === 0) {
                continue;
            }
            const groupKey = `${measure.value} ${measure.unit}`;
            const group = lengthGroups.get(groupKey) ?? { value: measure.value, unit: measure.unit, platforms: [] };
            for (const platform of measure.violators) {
                if (!group.platforms.includes(platform)) {
                    group.platforms.push(platform);
                }
            }
            lengthGroups.set(groupKey, group);
        }
        for (const group of lengthGroups.values()) {
            issues.push({
                message: `"${component}" is ${group.value} ${group.unit} long (max 255 per name)`,
                platforms: group.platforms,
            });
        }

        // Forbidden characters — grouped by the offending character.
        const forbiddenByChar = new Map<string, PlatformKey[]>();
        for (const key of targets) {
            const spec = PLATFORMS[key];
            for (const char of component) {
                const code = char.charCodeAt(0);
                const isControl = spec.forbidControl && code < 32;
                if (spec.forbidden.includes(char) || isControl) {
                    const printable = code >= 32 && code !== 0x7f;
                    const shown = printable ? char : `\\x${code.toString(16).padStart(2, '0')}`;
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

/**
 * Detect paths the selected platforms would treat as the same file:
 * names differing only by case (case-insensitive targets) and/or only by
 * Unicode normalization, e.g. NFC vs NFD "é" (normalization-insensitive targets).
 */
export function findNameCollisions(paths: string[], targets: PlatformKey[]): string[][] {
    const caseInsensitive = targets.some(key => PLATFORMS[key].caseInsensitive);
    const normInsensitive = targets.some(key => PLATFORMS[key].normalizationInsensitive);
    if (!caseInsensitive && !normInsensitive) {
        return [];
    }
    const buckets = new Map<string, string[]>();
    for (const path of paths) {
        let key = path;
        if (normInsensitive) {
            key = key.normalize('NFC');
        }
        if (caseInsensitive) {
            key = key.toLowerCase();
        }
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
        lines.push('## Colliding names (differ only by case or Unicode normalization)');
        for (const group of collisions) {
            lines.push(`- ${group.map(p => `\`${p}\``).join(' vs ')}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}
