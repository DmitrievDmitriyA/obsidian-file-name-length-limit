import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';

// Remember to rename these classes and interfaces!

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

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new FileNameLengthLimitSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
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
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('File name length limit')
			.setDesc('The limit is set for the file name including path')
			.addText(string => string
				.setPlaceholder('Enter the limit')
				.setValue(this.plugin.settings.lengthLimit.toString())
				.onChange(async (value) => {
					this.plugin.settings.lengthLimit = Number(value);
					await this.plugin.saveSettings();
				}));
	}
}
