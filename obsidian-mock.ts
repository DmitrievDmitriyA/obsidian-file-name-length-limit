// Minimal stand-in for the `obsidian` module, used only by the integration
// tests (vitest.config.ts aliases 'obsidian' to this file). Keeps just enough
// surface for main.ts to run outside the app. Not bundled into the plugin.

export class TAbstractFile {
    path = '';
    name = '';
}

export class TFile extends TAbstractFile {
    constructor(path = '') {
        super();
        this.path = path;
        this.name = path.split('/').pop() ?? path;
    }
}

export class FileSystemAdapter {
    private basePath: string;

    constructor(basePath = 'C:/Users/test/Vault') {
        this.basePath = basePath;
    }

    getBasePath(): string {
        return this.basePath;
    }
}

/** Messages shown via `new Notice(...)`, capturable by tests. */
export const notices: string[] = [];

export class Notice {
    constructor(message: string) {
        notices.push(message);
    }
}

export class App {}

function fakeStatusBarElement(): HTMLElement {
    const el = {
        text: '',
        classes: new Set<string>(),
        attrs: {} as Record<string, string>,
        setText(value: string) { el.text = value; },
        addClass(name: string) { el.classes.add(name); },
        removeClass(name: string) { el.classes.delete(name); },
        toggleClass(name: string, on: boolean) { on ? el.classes.add(name) : el.classes.delete(name); },
        setAttribute(name: string, value: string) { el.attrs[name] = value; },
        addEventListener() {},
        remove() {},
    };
    return el as unknown as HTMLElement;
}

export class Plugin {
    app: unknown;
    manifest: unknown;
    private storedData: unknown = null;

    constructor(app: unknown, manifest: unknown) {
        this.app = app;
        this.manifest = manifest;
    }

    addSettingTab() {}
    registerEvent() {}
    addCommand() {}

    addStatusBarItem(): HTMLElement {
        return fakeStatusBarElement();
    }

    async loadData(): Promise<unknown> {
        return this.storedData;
    }

    async saveData(data: unknown): Promise<void> {
        this.storedData = data;
    }

    /** Test helper: seed what loadData will return. */
    __setStoredData(data: unknown) {
        this.storedData = data;
    }
}

export class PluginSettingTab {
    app: unknown;

    constructor(app: unknown, _plugin: unknown) {
        this.app = app;
    }

    display() {}
}

export class Setting {
    settingEl = { addClass() {}, removeClass() {}, toggleClass() {} };
    constructor(_el: unknown) {}
    setName() { return this; }
    setDesc() { return this; }
    setHeading() { return this; }
    setClass() { return this; }
    setDisabled() { return this; }
    setPlaceholder() { return this; }
    addText() { return this; }
    addToggle() { return this; }
    addDropdown() { return this; }
}
