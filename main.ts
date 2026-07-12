import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from 'obsidian';

type PlatformKey = 'windows' | 'linux' | 'android' | 'ios';

interface PlatformSpec {
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

const INF = Number.POSITIVE_INFINITY;

// The character sets below reflect what sync targets actually reject in practice:
// Android's shared storage (used by sync clients) inherits the FAT/Windows set,
// while APFS mainly rejects the path separator and colon.
const PLATFORMS: Record<PlatformKey, PlatformSpec> = {
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

const PLATFORM_ORDER: PlatformKey[] = ['windows', 'linux', 'android', 'ios'];

const WINDOWS_RESERVED = new Set<string>([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

const REPORT_FILE_PATH = 'FileNameCompatibilityReport.md';

// Used when the vault path can't be auto-detected (e.g. on mobile).
const FALLBACK_WINDOWS_BUDGET = 90;

interface FileNameLengthLimitPluginSettings {
    targets: Record<PlatformKey, boolean>;
    /** Manual override for the device root path length. 0 means auto-detect. */
    windowsPathBudgetOverride: number;
    showStatusBar: boolean;
}

const DEFAULT_SETTINGS: FileNameLengthLimitPluginSettings = {
    targets: { windows: true, linux: true, android: true, ios: true },
    windowsPathBudgetOverride: 0,
    showStatusBar: true,
};

interface Issue {
    message: string;
    platforms: PlatformKey[];
}

function utf8Bytes(value: string): number {
    return new TextEncoder().encode(value).length;
}

function labelList(keys: PlatformKey[]): string {
    return keys.map(key => PLATFORMS[key].label).join(', ');
}

function reservedBase(component: string): string {
    const dot = component.indexOf('.');
    const base = dot === -1 ? component : component.slice(0, dot);
    return base.trim().toUpperCase();
}

export default class FileNameLengthLimitPlugin extends Plugin {
    settings: FileNameLengthLimitPluginSettings;
    statusBarEl?: HTMLElement;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new FileNameLengthLimitSettingTab(this.app, this));
        this.updateStatusBarVisibility();

        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile | null) => {
                this.notifyIfIncompatible(file);
                this.updateStatusBar();
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file: TAbstractFile) => {
                if (file instanceof TFile && file === this.app.workspace.getActiveFile()) {
                    this.notifyIfIncompatible(file);
                    this.updateStatusBar();
                }
            })
        );

        this.addCommand({
            id: 'check-all-file-names',
            name: 'Check all file names',
            callback: () => this.checkAllFileNames(),
        });
    }

    selectedTargets(): PlatformKey[] {
        return PLATFORM_ORDER.filter(key => this.settings.targets[key]);
    }

    /** Length of the vault's absolute location on this device, or null on platforms that hide it (e.g. mobile). */
    detectVaultPathLength(): number | null {
        const adapter = this.app.vault.adapter;
        if (adapter instanceof FileSystemAdapter) {
            // +1 for the separator between the vault root and the relative path.
            return adapter.getBasePath().length + 1;
        }
        return null;
    }

    /** Characters to reserve for the part of the Windows absolute path the plugin can't see. */
    effectiveWindowsBudget(): number {
        if (this.settings.windowsPathBudgetOverride > 0) {
            return this.settings.windowsPathBudgetOverride;
        }
        return this.detectVaultPathLength() ?? FALLBACK_WINDOWS_BUDGET;
    }

    /** Collect every cross-platform naming issue for a vault-relative path. */
    analyzePath(path: string): Issue[] {
        const targets = this.selectedTargets();
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
        const windowsBudget = this.effectiveWindowsBudget();
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

    notifyIfIncompatible(file: TFile | null) {
        if (!file) {
            return;
        }
        const issues = this.analyzePath(file.path);
        if (issues.length > 0) {
            const platforms = new Set<PlatformKey>();
            issues.forEach(issue => issue.platforms.forEach(p => platforms.add(p)));
            new Notice(
                `"${file.name}" is not compatible with ${labelList([...platforms])} ` +
                `(${issues.length} issue${issues.length === 1 ? '' : 's'}).`
            );
        }
    }

    async checkAllFileNames() {
        if (this.selectedTargets().length === 0) {
            new Notice('Select at least one target platform in the plugin settings.');
            return;
        }

        const affected = this.app.vault.getFiles()
            .map(file => ({ path: file.path, issues: this.analyzePath(file.path) }))
            .filter(entry => entry.issues.length > 0)
            .sort((a, b) => b.issues.length - a.issues.length);

        const collisions = this.findCaseCollisions();

        if (affected.length === 0 && collisions.length === 0) {
            new Notice('All file names are compatible with the selected platforms.');
            return;
        }

        const content = this.buildReport(affected, collisions);
        const existing = this.app.vault.getAbstractFileByPath(REPORT_FILE_PATH);
        let reportFile: TFile;
        if (existing instanceof TFile) {
            await this.app.vault.modify(existing, content);
            reportFile = existing;
        } else {
            reportFile = await this.app.vault.create(REPORT_FILE_PATH, content);
        }
        new Notice(`Report created: ${reportFile.path} (${affected.length} file(s))`);
    }

    /** Detect paths that differ only by case, which collide on case-insensitive targets. */
    findCaseCollisions(): string[][] {
        const caseInsensitive = this.selectedTargets().some(key => PLATFORMS[key].caseInsensitive);
        if (!caseInsensitive) {
            return [];
        }
        const buckets = new Map<string, string[]>();
        for (const file of this.app.vault.getFiles()) {
            const key = file.path.toLowerCase();
            const bucket = buckets.get(key) ?? [];
            bucket.push(file.path);
            buckets.set(key, bucket);
        }
        return [...buckets.values()].filter(paths => paths.length > 1);
    }

    buildReport(affected: { path: string; issues: Issue[] }[], collisions: string[][]): string {
        const targets = labelList(this.selectedTargets());
        const lines: string[] = [];
        lines.push('# File name compatibility report');
        lines.push('');
        lines.push(`Targets: ${targets}`);
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

    updateStatusBar() {
        if (!this.settings.showStatusBar || !this.statusBarEl) {
            return;
        }
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            this.statusBarEl.setText('File name length: 0');
            this.statusBarEl.removeClass('fnll-over-limit');
            this.statusBarEl.setAttribute('aria-label', 'No active file');
            return;
        }
        const issues = this.analyzePath(file.path);
        const overLimit = issues.length > 0;
        this.statusBarEl.setText(overLimit ? `⚠ File name length: ${file.path.length}` : `File name length: ${file.path.length}`);
        this.statusBarEl.toggleClass('fnll-over-limit', overLimit);
        this.statusBarEl.setAttribute(
            'aria-label',
            overLimit
                ? `${issues.length} compatibility issue(s) — click to list all files`
                : 'File name is compatible — click to list all files'
        );
    }

    updateStatusBarVisibility() {
        if (this.settings.showStatusBar) {
            if (!this.statusBarEl) {
                this.statusBarEl = this.addStatusBarItem();
                this.statusBarEl.addClass('mod-clickable');
                this.statusBarEl.addEventListener('click', () => this.checkAllFileNames());
            }
            this.updateStatusBar();
        } else {
            this.statusBarEl?.remove();
            this.statusBarEl = undefined;
        }
    }

    async loadSettings() {
        const stored = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
        // Guard against a partially-stored targets object from older versions.
        this.settings.targets = Object.assign({}, DEFAULT_SETTINGS.targets, this.settings.targets);
    }

    async saveSettings() {
        await this.saveData(this.settings);
        this.updateStatusBarVisibility();
    }

    onunload() {
        this.statusBarEl?.remove();
    }
}

class FileNameLengthLimitSettingTab extends PluginSettingTab {
    plugin: FileNameLengthLimitPlugin;

    constructor(app: App, plugin: FileNameLengthLimitPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;

        containerEl.empty();

        new Setting(containerEl)
            .setName('Target platforms')
            .setDesc('Select every system this vault syncs to. The strictest combination of limits and allowed characters is applied.')
            .setHeading();

        for (const key of PLATFORM_ORDER) {
            new Setting(containerEl)
                .setName(PLATFORMS[key].label)
                .addToggle(toggle => toggle
                    .setValue(this.plugin.settings.targets[key])
                    .onChange(async (value) => {
                        this.plugin.settings.targets[key] = value;
                        await this.plugin.saveSettings();
                    }));
        }

        const detected = this.plugin.detectVaultPathLength();
        const detectedNote = detected !== null
            ? `Auto-detected from this device: ${detected} characters.`
            : `This device's vault path can't be detected (e.g. on mobile); a default of ${FALLBACK_WINDOWS_BUDGET} is used.`;
        new Setting(containerEl)
            .setName('Windows vault path length')
            .setDesc(`Windows caps the full absolute path at 260 characters, including your vault's location (e.g. "C:\\Users\\me\\Documents\\MyVault\\"). ${detectedNote} Leave blank to use it, or enter a value to override — useful if another Windows device you sync to has a longer path. Only used when Windows is selected.`)
            .addText(text => text
                .setPlaceholder(detected !== null ? `Auto: ${detected}` : String(FALLBACK_WINDOWS_BUDGET))
                .setValue(this.plugin.settings.windowsPathBudgetOverride > 0
                    ? this.plugin.settings.windowsPathBudgetOverride.toString()
                    : '')
                .onChange(async (value) => {
                    const trimmed = value.trim();
                    if (trimmed === '') {
                        this.plugin.settings.windowsPathBudgetOverride = 0;
                        await this.plugin.saveSettings();
                        return;
                    }
                    const parsed = Number(trimmed);
                    if (!Number.isFinite(parsed) || parsed < 0) {
                        return;
                    }
                    this.plugin.settings.windowsPathBudgetOverride = Math.floor(parsed);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show status bar indicator')
            .setDesc('Show the active file\'s length and a warning when it is incompatible.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showStatusBar)
                .onChange(async (value) => {
                    this.plugin.settings.showStatusBar = value;
                    await this.plugin.saveSettings();
                }));
    }
}
