import { App, FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from 'obsidian';
import {
    analyzePath,
    buildReport,
    findCaseCollisions,
    Issue,
    labelList,
    PLATFORM_ORDER,
    PLATFORMS,
    PlatformKey,
} from './analyzer';

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
    issuesForPath(path: string): Issue[] {
        return analyzePath(path, this.selectedTargets(), this.effectiveWindowsBudget());
    }

    notifyIfIncompatible(file: TFile | null) {
        if (!file) {
            return;
        }
        const issues = this.issuesForPath(file.path);
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
            .map(file => ({ path: file.path, issues: this.issuesForPath(file.path) }))
            .filter(entry => entry.issues.length > 0)
            .sort((a, b) => b.issues.length - a.issues.length);

        const paths = this.app.vault.getFiles().map(file => file.path);
        const collisions = findCaseCollisions(paths, this.selectedTargets());

        if (affected.length === 0 && collisions.length === 0) {
            new Notice('All file names are compatible with the selected platforms.');
            return;
        }

        const content = buildReport(this.selectedTargets(), affected, collisions);
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
        const issues = this.issuesForPath(file.path);
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
