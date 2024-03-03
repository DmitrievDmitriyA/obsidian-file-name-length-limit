import { App, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';

interface FileNameLengthLimitPluginSettings {
    lengthLimit: number;
}

const DEFAULT_SETTINGS: FileNameLengthLimitPluginSettings = {
    lengthLimit: 255
}

export default class FileNameLengthLimitPlugin extends Plugin {
    settings: FileNameLengthLimitPluginSettings;

    async onload() {
        await this.loadSettings();

        this.addSettingTab(new FileNameLengthLimitSettingTab(this.app, this));

        // Check file length when a new file becomes active
        this.registerEvent(
            this.app.workspace.on('file-open', (file: TFile) => {
                this.checkFileLength(file);
            })
        );

        // Check file length when the active file's name is changed
        this.registerEvent(
            this.app.vault.on('rename', (file: TFile) => {
                if (file === this.app.workspace.getActiveFile()) {
                    this.checkFileLength(file);
                }
            })
        );

		// Add a command to check all files and generate a report
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

    onunload() {

    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
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
    }
}
