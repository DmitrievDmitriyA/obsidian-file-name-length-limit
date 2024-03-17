import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface FileNameLengthLimitPluginSettings {
    lengthLimit: number;
    showStatusBar: boolean;
}

const DEFAULT_SETTINGS: FileNameLengthLimitPluginSettings = {
    lengthLimit: 144,
    showStatusBar: true
};

export default class FileNameLengthLimitPlugin extends Plugin {
    settings: FileNameLengthLimitPluginSettings;
    statusBarEl?: HTMLElement;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new FileNameLengthLimitSettingTab(this.app, this));
        this.updateStatusBarVisibility();

        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile) => {
                this.checkFileLength(file);
                this.updateStatusBar();
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', (file: TFile) => {
                if (file === this.app.workspace.getActiveFile()) {
                    this.checkFileLength(file);
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

    checkFileLength(file: TFile) {
        const length = file.path.length;
        if (length > this.settings.lengthLimit) {
            new Notice(`File length exceeds the limit! Length: ${length}, Limit: ${this.settings.lengthLimit}`);
        }
    }

    async checkAllFileNames() {
        const filesWithLongNames: string[] = [];
        this.app.vault.getFiles().forEach(file => {
            if (file.path.length > this.settings.lengthLimit) {
                filesWithLongNames.push(file.path);
            }
        });

        if (filesWithLongNames.length > 0) {
            const reportContent = filesWithLongNames.map(path => `- [[${path}]]`).join('\n');
            const reportFile = await this.app.vault.create('FilesWithTooLongNames.md', reportContent);
            new Notice(`Report created: ${reportFile.path}`);
        } else {
            new Notice('No files with names exceeding the length limit.');
        }
    }

    updateStatusBar() {
        if (this.settings.showStatusBar && this.statusBarEl) {
            const file = this.app.workspace.getActiveFile();
            const length = file ? file.path.length : 0;
            this.statusBarEl.setText(`Length: ${length}`);
        }
    }

    updateStatusBarVisibility() {
        if (this.settings.showStatusBar) {
            if (!this.statusBarEl) {
                this.statusBarEl = this.addStatusBarItem();
            }
            this.updateStatusBar();
        } else {
            this.statusBarEl?.remove();
            this.statusBarEl = undefined;
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
            .setName('File name length limit')
            .setDesc('The limit is set for the file name including path')
            .addText(text => text
                .setPlaceholder('Enter the limit')
                .setValue(this.plugin.settings.lengthLimit.toString())
                .onChange(async (value) => {
                    this.plugin.settings.lengthLimit = Number(value);
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Show Length in Status Bar')
            .setDesc('Toggle the visibility of the file name length in the status bar.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.showStatusBar)
                .onChange(async (value) => {
                    this.plugin.settings.showStatusBar = value;
                    await this.plugin.saveSettings();
                }));
    }
}