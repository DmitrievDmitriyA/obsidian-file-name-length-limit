import { App, FileSystemAdapter, MarkdownView, Notice, Platform, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from 'obsidian';
import {
    analyzePath,
    buildReport,
    findNameCollisions,
    Issue,
    labelList,
    PLATFORM_ORDER,
    PLATFORMS,
    PlatformKey,
} from './analyzer';

const REPORT_FILE_PATH = 'FileNameCompatibilityReport.md';

// Used when the vault path can't be auto-detected (e.g. on mobile).
const FALLBACK_WINDOWS_BUDGET = 90;

type StatusBarFormat = 'length' | 'ratio';

interface FileNameLengthLimitPluginSettings {
    targets: Record<PlatformKey, boolean>;
    /** Manual override for the device root path length. 0 means auto-detect. */
    windowsPathBudgetOverride: number;
    /** Vault path length last auto-detected on a Windows device; synced via data.json so other devices can use it. 0 = never detected. */
    detectedWindowsPathLength: number;
    showStatusBar: boolean;
    /** 'length' shows just the current length; 'ratio' shows length / strictest limit. */
    statusBarFormat: StatusBarFormat;
}

const DEFAULT_SETTINGS: FileNameLengthLimitPluginSettings = {
    targets: { windows: true, linux: true, android: true, ios: true },
    windowsPathBudgetOverride: 0,
    detectedWindowsPathLength: 0,
    showStatusBar: true,
    statusBarFormat: 'ratio',
};

export default class FileNameLengthLimitPlugin extends Plugin {
    settings: FileNameLengthLimitPluginSettings;
    statusBarEl?: HTMLElement;

    async onload() {
        await this.loadSettings();
        await this.persistDetectedWindowsPathLength();

        this.addSettingTab(new FileNameLengthLimitSettingTab(this.app, this));
        this.updateStatusBarVisibility();

        this.app.workspace.onLayoutReady(() => this.updateTitleMark());

        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile | null) => {
                this.notifyIfIncompatible(file);
                this.updateStatusBar();
                // Give the view a tick to render the new inline title first.
                window.setTimeout(() => this.updateTitleMark(), 0);
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
                this.noticedPaths.delete(oldPath);
                // A folder rename changes the paths of every file inside it, so
                // re-evaluate the active file no matter what was renamed.
                this.notifyIfIncompatible(this.app.workspace.getActiveFile());
                this.updateStatusBar();
                window.setTimeout(() => this.updateTitleMark(), 0);
            })
        );

        this.addCommand({
            id: 'check-all-file-names',
            name: 'Check all file names',
            callback: () => this.checkAllFileNames(),
        });

        // Warn while a name is being typed, before Obsidian applies the rename —
        // especially on phones, where a rejected rename discards the typing.
        // Covers the inline note title and the file explorer's rename field.
        this.registerDomEvent(document, 'input', (evt: Event) => {
            const target = evt.target;
            if (!(target instanceof HTMLElement)) {
                return;
            }
            if (target.classList.contains('inline-title')) {
                this.previewTitleInput(target);
                return;
            }
            const dataPath = target.closest('.nav-file-title, .nav-folder-title')?.getAttribute('data-path');
            if (dataPath) {
                this.previewExplorerRename(target, dataPath);
            }
        });

        // When a name-editing field loses focus, Obsidian applies or rejects the
        // rename (often resetting the text without an input event). Re-sync the
        // mark with the saved state; a following rename event re-syncs again.
        this.registerDomEvent(document, 'focusout', (evt: Event) => {
            const target = evt.target;
            if (target instanceof HTMLElement && target.classList.contains('fnll-title-over-limit')) {
                window.setTimeout(() => this.updateTitleMark(), 0);
            }
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

    /**
     * On a Windows device, remember the detected vault path length in the synced
     * settings so phones and other devices use the real value instead of the fallback.
     */
    async persistDetectedWindowsPathLength() {
        if (!Platform.isWin) {
            return;
        }
        const detected = this.detectVaultPathLength();
        if (detected !== null && detected !== this.settings.detectedWindowsPathLength) {
            this.settings.detectedWindowsPathLength = detected;
            await this.saveSettings();
        }
    }

    /** Characters to reserve for the part of the Windows absolute path the plugin can't see. */
    effectiveWindowsBudget(): number {
        if (this.settings.windowsPathBudgetOverride > 0) {
            return this.settings.windowsPathBudgetOverride;
        }
        if (Platform.isWin) {
            return this.detectVaultPathLength() ?? FALLBACK_WINDOWS_BUDGET;
        }
        // Elsewhere, a value detected on a real Windows device beats this device's
        // own path (a rough proxy at best) and the blind fallback.
        if (this.settings.detectedWindowsPathLength > 0) {
            return this.settings.detectedWindowsPathLength;
        }
        return this.detectVaultPathLength() ?? FALLBACK_WINDOWS_BUDGET;
    }

    /** Collect every cross-platform naming issue for a vault-relative path. */
    issuesForPath(path: string): Issue[] {
        return analyzePath(path, this.selectedTargets(), this.effectiveWindowsBudget());
    }

    /** The strictest allowed relative-path length across the selected platforms, or null when none are selected. */
    effectivePathLimit(): number | null {
        const targets = this.selectedTargets();
        if (targets.length === 0) {
            return null;
        }
        const budget = this.effectiveWindowsBudget();
        return Math.min(...targets.map(key => {
            const spec = PLATFORMS[key];
            return spec.maxPathUnits - (spec.usesPrefixBudget ? budget : 0);
        }));
    }

    /** True while an over-limit notice for the typed title is already on screen. */
    private titleWarningShown = false;

    /** Paths already announced by the open-file notice; entries drop out when the file is renamed or becomes compatible. */
    private noticedPaths = new Set<string>();

    /**
     * Drop leftover typing marks (a programmatic title reset fires no input event
     * to clear them), then re-mark the inline title if the active file's saved
     * name is itself incompatible.
     */
    private updateTitleMark() {
        document.querySelectorAll('.fnll-title-over-limit').forEach(el => el.classList.remove('fnll-title-over-limit'));
        this.titleWarningShown = false;
        // Check every open markdown pane, not just the focused leaf — during an
        // explorer rename the focused leaf is the explorer itself.
        this.app.workspace.getLeavesOfType('markdown').forEach(leaf => {
            if (!(leaf.view instanceof MarkdownView)) {
                return;
            }
            const file = leaf.view.file;
            if (!file || this.issuesForPath(file.path).length === 0) {
                return;
            }
            leaf.view.containerEl.querySelector('.inline-title')?.classList.add('fnll-title-over-limit');
        });
    }

    /** The vault path the active file would get if its basename became `typed`. */
    prospectivePath(file: TFile, typed: string): string {
        const dir = file.path.slice(0, file.path.length - file.name.length);
        const dot = file.name.lastIndexOf('.');
        const ext = dot > 0 ? file.name.slice(dot) : '';
        return `${dir}${typed}${ext}`;
    }

    /** Live check of the typed (not yet applied) note title; marks the title and warns once per episode. */
    previewTitleInput(titleEl: HTMLElement) {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
            return;
        }
        const typed = (titleEl.textContent ?? '').trim();
        if (typed.length === 0) {
            titleEl.toggleClass('fnll-title-over-limit', false);
            this.titleWarningShown = false;
            this.updateStatusBar();
            return;
        }
        this.markTypedName(titleEl, this.prospectivePath(file, typed), true);
    }

    /** Live check while a file or folder is being renamed in the file explorer. */
    previewExplorerRename(renameEl: HTMLElement, dataPath: string) {
        const updateBar = this.app.workspace.getActiveFile()?.path === dataPath;
        const typed = (renameEl.textContent ?? '').trim();
        if (typed.length === 0) {
            renameEl.toggleClass('fnll-title-over-limit', false);
            this.titleWarningShown = false;
            if (updateBar) {
                this.updateStatusBar();
            }
            return;
        }
        const current = this.app.vault.getAbstractFileByPath(dataPath);
        let prospective: string;
        if (current instanceof TFile) {
            // The rename field may or may not include the extension; don't attach it twice.
            const dot = current.name.lastIndexOf('.');
            const ext = dot > 0 ? current.name.slice(dot) : '';
            prospective = ext !== '' && typed.toLowerCase().endsWith(ext.toLowerCase())
                ? current.path.slice(0, current.path.length - current.name.length) + typed
                : this.prospectivePath(current, typed);
        } else {
            // Folder (or unknown): the typed text is the whole final component.
            const slash = dataPath.lastIndexOf('/');
            prospective = (slash >= 0 ? dataPath.slice(0, slash + 1) : '') + typed;
        }
        this.markTypedName(renameEl, prospective, updateBar);
    }

    /** Shared tail of the typing previews: mark the field, mirror the status bar, warn once per episode. */
    private markTypedName(el: HTMLElement, prospective: string, updateBar: boolean) {
        const issues = this.issuesForPath(prospective);
        const over = issues.length > 0;
        el.toggleClass('fnll-title-over-limit', over);
        if (updateBar) {
            this.updateStatusBar(prospective);
        }
        if (!over) {
            this.titleWarningShown = false;
            return;
        }
        if (!this.titleWarningShown) {
            const platforms = new Set<PlatformKey>();
            issues.forEach(issue => issue.platforms.forEach(p => platforms.add(p)));
            new Notice(`This name won't work on ${labelList([...platforms])} — shorten it before confirming.`);
            this.titleWarningShown = true;
        }
    }

    notifyIfIncompatible(file: TFile | null) {
        if (!file) {
            return;
        }
        const issues = this.issuesForPath(file.path);
        if (issues.length === 0) {
            this.noticedPaths.delete(file.path);
            return;
        }
        // Announce each file once until its name changes; re-opening it every time
        // would repeat the same notice all over the vault.
        if (this.noticedPaths.has(file.path)) {
            return;
        }
        this.noticedPaths.add(file.path);
        const platforms = new Set<PlatformKey>();
        issues.forEach(issue => issue.platforms.forEach(p => platforms.add(p)));
        new Notice(
            `"${file.name}" is not compatible with ${labelList([...platforms])} ` +
            `(${issues.length} issue${issues.length === 1 ? '' : 's'}).`
        );
    }

    async checkAllFileNames() {
        const targets = this.selectedTargets();
        if (targets.length === 0) {
            new Notice('Select at least one target platform in the plugin settings.');
            return;
        }

        const paths = this.app.vault.getFiles().map(file => file.path);

        const affected = paths
            .map(path => ({ path, issues: this.issuesForPath(path) }))
            .filter(entry => entry.issues.length > 0)
            .sort((a, b) => b.issues.length - a.issues.length);

        const collisions = findNameCollisions(paths, targets);

        if (affected.length === 0 && collisions.length === 0) {
            new Notice('All file names are compatible with the selected platforms.');
            return;
        }

        const content = buildReport(targets, affected, collisions);
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

    /** With `previewPath`, reflects a name still being typed instead of the saved one. */
    updateStatusBar(previewPath?: string) {
        if (!this.settings.showStatusBar || !this.statusBarEl) {
            return;
        }
        const path = previewPath ?? this.app.workspace.getActiveFile()?.path;
        if (path === undefined) {
            this.statusBarEl.setText('File name length: 0');
            this.statusBarEl.removeClass('fnll-over-limit');
            this.statusBarEl.setAttribute('aria-label', 'No active file');
            return;
        }
        const issues = this.issuesForPath(path);
        const overLimit = issues.length > 0;
        const limit = this.effectivePathLimit();
        const shown = this.settings.statusBarFormat === 'ratio' && limit !== null
            ? `${path.length} / ${limit}`
            : `${path.length}`;
        this.statusBarEl.setText(overLimit ? `⚠ File name length: ${shown}` : `File name length: ${shown}`);
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
                this.statusBarEl.addEventListener('click', () => { void this.checkAllFileNames(); });
            }
            this.updateStatusBar();
        } else {
            this.statusBarEl?.remove();
            this.statusBarEl = undefined;
        }
    }

    async loadSettings() {
        const stored = (await this.loadData()) as Partial<FileNameLengthLimitPluginSettings> | null;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
        // Guard against a partially-stored targets object from older versions.
        this.settings.targets = Object.assign({}, DEFAULT_SETTINGS.targets, stored?.targets);
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

        const remembered = this.plugin.settings.detectedWindowsPathLength;
        const detected = this.plugin.detectVaultPathLength();
        const detectedNote = Platform.isWin && detected !== null
            ? `Auto-detected from this device: ${detected} characters.`
            : remembered > 0
                ? `Using the value detected on your Windows device: ${remembered} characters (synced with the plugin settings).`
                : detected !== null
                    ? `Estimated from this device's own path: ${detected} characters.`
                    : `This device's vault path can't be detected; a default of ${FALLBACK_WINDOWS_BUDGET} is used until you open the vault on a Windows device.`;
        const autoValue = Platform.isWin && detected !== null
            ? detected
            : remembered > 0 ? remembered : detected;
        new Setting(containerEl)
            .setName('Windows vault path length')
            .setDesc(`Windows caps the full absolute path at 260 characters, including your vault's location (e.g. "C:\\Users\\me\\Documents\\MyVault\\"). ${detectedNote} Leave blank to use it, or enter a value to override — useful if another Windows device you sync to has a longer path. Only used when Windows is selected.`)
            .addText(text => text
                .setPlaceholder(autoValue !== null ? `Auto: ${autoValue}` : String(FALLBACK_WINDOWS_BUDGET))
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
                    this.display();
                }));

        const formatSetting = new Setting(containerEl)
            .setName('Status bar format')
            .setDesc('Show just the current length, or the length next to the strictest path limit of the selected platforms (e.g. "104 / 246").')
            .setClass('fnll-sub-setting')
            .addDropdown(dropdown => dropdown
                .addOption('ratio', 'Length / limit')
                .addOption('length', 'Current length only')
                .setValue(this.plugin.settings.statusBarFormat)
                .onChange(async (value) => {
                    this.plugin.settings.statusBarFormat = value as StatusBarFormat;
                    await this.plugin.saveSettings();
                }));
        formatSetting.setDisabled(!this.plugin.settings.showStatusBar);
        formatSetting.settingEl.toggleClass('fnll-disabled', !this.plugin.settings.showStatusBar);
    }
}
