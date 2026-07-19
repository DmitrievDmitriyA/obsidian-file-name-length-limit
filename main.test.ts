// Integration tests for the Obsidian glue in main.ts, run against the mocked
// `obsidian` module (see vitest.config.ts). Covers what the analyzer unit tests
// cannot: settings loading/migration, budget auto-detection, report writing,
// and user-facing notices.

import { beforeEach, describe, expect, it } from 'vitest';
import FileNameLengthLimitPlugin, { FileNameLengthLimitSettingTab } from './main';
import { App, FileSystemAdapter, notices, Platform, TFile } from './obsidian-mock';

interface TestVault {
    files: TFile[];
    adapter: unknown;
    created: Map<string, TFile>;
    contents: Map<string, string>;
    createCalls: number;
    modifyCalls: number;
}

function makePlugin(options: { files?: string[]; adapter?: unknown; stored?: unknown; activeFile?: string } = {}) {
    const vaultState: TestVault = {
        files: (options.files ?? []).map(p => new TFile(p)),
        adapter: options.adapter ?? {},
        created: new Map(),
        contents: new Map(),
        createCalls: 0,
        modifyCalls: 0,
    };

    const vault = {
        adapter: vaultState.adapter,
        on() {},
        getFiles: () => vaultState.files,
        getAbstractFileByPath: (p: string) => vaultState.created.get(p) ?? null,
        create: async (p: string, content: string) => {
            vaultState.createCalls++;
            const file = new TFile(p);
            vaultState.created.set(p, file);
            vaultState.contents.set(p, content);
            return file;
        },
        modify: async (file: TFile, content: string) => {
            vaultState.modifyCalls++;
            vaultState.contents.set(file.path, content);
        },
    };

    const activeFile = options.activeFile ? new TFile(options.activeFile) : null;
    const workspace = { on() {}, getActiveFile: () => activeFile };
    const plugin = new FileNameLengthLimitPlugin({ vault, workspace } as never, {} as never);
    if (options.stored !== undefined) {
        (plugin as unknown as { __setStoredData(d: unknown): void }).__setStoredData(options.stored);
    }
    return { plugin, vaultState };
}

beforeEach(() => {
    notices.length = 0;
    Platform.isWin = false;
});

describe('loadSettings', () => {
    it('uses defaults when nothing is stored', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        expect(plugin.settings.targets).toEqual({ windows: true, linux: true, android: true, ios: true });
        expect(plugin.settings.windowsPathBudgetOverride).toBe(0);
        expect(plugin.settings.showStatusBar).toBe(true);
        expect(plugin.settings.statusBarFormat).toBe('ratio');
    });

    it('merges a partially-stored targets object (older-version data)', async () => {
        const { plugin } = makePlugin({ stored: { targets: { windows: false }, showStatusBar: false } });
        await plugin.loadSettings();
        expect(plugin.settings.targets.windows).toBe(false);
        expect(plugin.settings.targets.linux).toBe(true);
        expect(plugin.settings.targets.ios).toBe(true);
        expect(plugin.settings.showStatusBar).toBe(false);
    });

    it('ignores unknown legacy keys without crashing', async () => {
        const { plugin } = makePlugin({ stored: { lengthLimit: 144, measureMode: 'path' } });
        await plugin.loadSettings();
        expect(plugin.settings.targets.windows).toBe(true);
        expect(plugin.settings.windowsPathBudgetOverride).toBe(0);
    });
});

describe('effectiveWindowsBudget', () => {
    it('prefers a manual override', async () => {
        const { plugin } = makePlugin({ adapter: new FileSystemAdapter('C:/Base/Vault') });
        await plugin.loadSettings();
        plugin.settings.windowsPathBudgetOverride = 120;
        expect(plugin.effectiveWindowsBudget()).toBe(120);
    });

    it('auto-detects from the vault path (+1 separator)', async () => {
        const base = 'C:/Base/Vault';
        const { plugin } = makePlugin({ adapter: new FileSystemAdapter(base) });
        await plugin.loadSettings();
        expect(plugin.effectiveWindowsBudget()).toBe(base.length + 1);
    });

    it('falls back to 90 when the adapter hides the path (mobile)', async () => {
        const { plugin } = makePlugin({ adapter: {} });
        await plugin.loadSettings();
        expect(plugin.effectiveWindowsBudget()).toBe(90);
    });

    it('prefers the synced Windows-detected value on non-Windows devices', async () => {
        // Mobile (no adapter path) with a value previously stored by a Windows device.
        const mobile = makePlugin({ adapter: {}, stored: { detectedWindowsPathLength: 21 } });
        await mobile.plugin.loadSettings();
        expect(mobile.plugin.effectiveWindowsBudget()).toBe(21);

        // A non-Windows desktop also prefers the real Windows value over its own path.
        const desktop = makePlugin({
            adapter: new FileSystemAdapter('/home/user/very/long/vault/location'),
            stored: { detectedWindowsPathLength: 21 },
        });
        await desktop.plugin.loadSettings();
        expect(desktop.plugin.effectiveWindowsBudget()).toBe(21);
    });
});

describe('persistDetectedWindowsPathLength', () => {
    it('stores the detected value on Windows so other devices can sync it', async () => {
        Platform.isWin = true;
        const base = 'C:/Base/Vault';
        const { plugin } = makePlugin({ adapter: new FileSystemAdapter(base) });
        await plugin.loadSettings();
        await plugin.persistDetectedWindowsPathLength();
        expect(plugin.settings.detectedWindowsPathLength).toBe(base.length + 1);

        // Round-trips through saveData: a fresh load sees the persisted value.
        const stored = await (plugin as unknown as { loadData(): Promise<unknown> }).loadData();
        expect((stored as { detectedWindowsPathLength: number }).detectedWindowsPathLength).toBe(base.length + 1);
    });

    it('does nothing on non-Windows devices', async () => {
        const { plugin } = makePlugin({ adapter: new FileSystemAdapter('/home/user/vault') });
        await plugin.loadSettings();
        await plugin.persistDetectedWindowsPathLength();
        expect(plugin.settings.detectedWindowsPathLength).toBe(0);
    });
});

describe('checkAllFileNames', () => {
    it('creates the report once and overwrites it on re-run', async () => {
        const { plugin, vaultState } = makePlugin({ files: ['CON.md', 'ok.md'] });
        await plugin.loadSettings();

        await plugin.checkAllFileNames();
        expect(vaultState.createCalls).toBe(1);
        const content = vaultState.contents.get('FileNameCompatibilityReport.md');
        expect(content).toContain('## [[CON.md]]');
        expect(content).toContain('reserved name');
        expect(content).not.toContain('[[ok.md]]');

        await plugin.checkAllFileNames();
        expect(vaultState.createCalls).toBe(1);
        expect(vaultState.modifyCalls).toBe(1);
    });

    it('reports collisions and issue-free vaults correctly', async () => {
        const clean = makePlugin({ files: ['a.md', 'b.md'] });
        await clean.plugin.loadSettings();
        await clean.plugin.checkAllFileNames();
        expect(clean.vaultState.createCalls).toBe(0);
        expect(notices.some(n => /compatible/.test(n))).toBe(true);

        const colliding = makePlugin({ files: ['Note.md', 'note.md'] });
        await colliding.plugin.loadSettings();
        await colliding.plugin.checkAllFileNames();
        const content = colliding.vaultState.contents.get('FileNameCompatibilityReport.md');
        expect(content).toContain('Colliding names');
    });

    it('asks for a target platform when none are selected', async () => {
        const { plugin, vaultState } = makePlugin({ files: ['CON.md'] });
        await plugin.loadSettings();
        plugin.settings.targets = { windows: false, linux: false, android: false, ios: false };
        await plugin.checkAllFileNames();
        expect(vaultState.createCalls).toBe(0);
        expect(notices.some(n => /at least one target platform/.test(n))).toBe(true);
    });
});

describe('status bar', () => {
    function statusText(plugin: FileNameLengthLimitPlugin): string {
        plugin.updateStatusBarVisibility();
        return (plugin.statusBarEl as unknown as { text: string }).text;
    }

    it('shows length / strictest limit by default', async () => {
        // Budget = len('C:/Base/Vault') + 1 = 14; strictest = min(260-14, 4096, 4096, 1024) = 246.
        const { plugin } = makePlugin({ activeFile: 'note.md', adapter: new FileSystemAdapter('C:/Base/Vault') });
        await plugin.loadSettings();
        expect(statusText(plugin)).toBe('File name length: 7 / 246');
    });

    it('shows just the length in length-only format', async () => {
        const { plugin } = makePlugin({ activeFile: 'note.md' });
        await plugin.loadSettings();
        plugin.settings.statusBarFormat = 'length';
        expect(statusText(plugin)).toBe('File name length: 7');
    });

    it('hides the item when no note is open', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        plugin.updateStatusBarVisibility();
        const bar = plugin.statusBarEl as unknown as { text: string; classes: Set<string> };
        expect(bar.classes.has('fnll-hidden')).toBe(true);
        expect(bar.text).toBe('');
    });

    it('keeps the warning prefix for incompatible files', async () => {
        const { plugin } = makePlugin({ activeFile: 'CON.md' });
        await plugin.loadSettings();
        expect(statusText(plugin)).toContain('⚠');
    });
});

describe('previewTitleInput', () => {
    function fakeTitleEl(text: string) {
        const el = {
            textContent: text,
            classes: new Set<string>(),
            toggleClass(name: string, on: boolean) { on ? el.classes.add(name) : el.classes.delete(name); },
        };
        return el;
    }

    it('marks the title and warns once while the typed name is too long', async () => {
        const { plugin } = makePlugin({ activeFile: 'note.md' });
        await plugin.loadSettings();

        const el = fakeTitleEl('a'.repeat(300));
        plugin.previewTitleInput(el as unknown as HTMLElement);
        expect(el.classes.has('fnll-title-over-limit')).toBe(true);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('shorten it');

        // Still over the limit: no second notice while the first episode lasts.
        el.textContent = 'a'.repeat(301);
        plugin.previewTitleInput(el as unknown as HTMLElement);
        expect(notices).toHaveLength(1);

        // Back under the limit: mark cleared, next episode warns again.
        el.textContent = 'short';
        plugin.previewTitleInput(el as unknown as HTMLElement);
        expect(el.classes.has('fnll-title-over-limit')).toBe(false);
        el.textContent = 'a'.repeat(300);
        plugin.previewTitleInput(el as unknown as HTMLElement);
        expect(notices).toHaveLength(2);
    });

    it('live-updates the status bar with the typed length while typing', async () => {
        // Budget 14 (see status bar tests) → strictest limit 246; 'a'*300 + '.md' = 303 chars.
        const { plugin } = makePlugin({ activeFile: 'note.md', adapter: new FileSystemAdapter('C:/Base/Vault') });
        await plugin.loadSettings();
        plugin.updateStatusBarVisibility();
        const bar = plugin.statusBarEl as unknown as { text: string; classes: Set<string> };

        plugin.previewTitleInput(fakeTitleEl('a'.repeat(300)) as unknown as HTMLElement);
        expect(bar.text).toBe('⚠ File name length: 303 / 246');
        expect(bar.classes.has('fnll-over-limit')).toBe(true);

        plugin.previewTitleInput(fakeTitleEl('ok') as unknown as HTMLElement);
        expect(bar.text).toBe('File name length: 5 / 246');
        expect(bar.classes.has('fnll-over-limit')).toBe(false);
    });

    it('builds the prospective path from the active file directory and extension', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        expect(plugin.prospectivePath(new TFile('notes/old.md') as never, 'new name')).toBe('notes/new name.md');
        expect(plugin.prospectivePath(new TFile('root.md') as never, 'renamed')).toBe('renamed.md');
    });
});

describe('previewExplorerRename', () => {
    function fakeTitleEl(text: string) {
        const el = {
            textContent: text,
            classes: new Set<string>(),
            toggleClass(name: string, on: boolean) { on ? el.classes.add(name) : el.classes.delete(name); },
        };
        return el;
    }

    it('flags an over-limit folder rename and clears when emptied', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();

        const el = fakeTitleEl('a'.repeat(300));
        plugin.previewExplorerRename(el as unknown as HTMLElement, 'parent/folder');
        expect(el.classes.has('fnll-title-over-limit')).toBe(true);
        expect(notices).toHaveLength(1);

        el.textContent = '';
        plugin.previewExplorerRename(el as unknown as HTMLElement, 'parent/folder');
        expect(el.classes.has('fnll-title-over-limit')).toBe(false);
    });

    it('does not attach the extension twice when the rename field includes it', async () => {
        // The renamed file is also the active one, so the status bar mirrors the
        // prospective path — that is how we observe the computed length.
        const { plugin, vaultState } = makePlugin({ activeFile: 'notes/pic.png' });
        await plugin.loadSettings();
        vaultState.created.set('notes/pic.png', new TFile('notes/pic.png'));
        plugin.updateStatusBarVisibility();
        const bar = plugin.statusBarEl as unknown as { text: string };

        // 'notes/pica.png'.length = 14 either way.
        plugin.previewExplorerRename(fakeTitleEl('pica.png') as unknown as HTMLElement, 'notes/pic.png');
        const withExt = bar.text;
        plugin.previewExplorerRename(fakeTitleEl('pica') as unknown as HTMLElement, 'notes/pic.png');
        expect(bar.text).toBe(withExt);
        expect(bar.text).toContain('14');
    });
});

describe('settings tab (declarative API)', () => {
    async function makeTab(options: Parameters<typeof makePlugin>[0] = {}) {
        const { plugin } = makePlugin(options);
        await plugin.loadSettings();
        return { plugin, tab: new FileNameLengthLimitSettingTab(new App() as never, plugin) };
    }

    it('maps dotted target keys to the targets record', async () => {
        const { plugin, tab } = await makeTab();
        expect(tab.getControlValue('targets.windows')).toBe(true);
        await tab.setControlValue('targets.windows', false);
        expect(plugin.settings.targets.windows).toBe(false);
        expect(tab.getControlValue('targets.windows')).toBe(false);
        // Persisted, not just mutated in memory.
        const stored = await (plugin as unknown as { loadData(): Promise<{ targets: { windows: boolean } }> }).loadData();
        expect(stored.targets.windows).toBe(false);
    });

    it('treats the budget override as empty when auto (0) and clears it on blank input', async () => {
        const { plugin, tab } = await makeTab();
        expect(tab.getControlValue('windowsPathBudgetOverride')).toBeUndefined();
        await tab.setControlValue('windowsPathBudgetOverride', 120.7);
        expect(plugin.settings.windowsPathBudgetOverride).toBe(120);
        await tab.setControlValue('windowsPathBudgetOverride', null);
        expect(plugin.settings.windowsPathBudgetOverride).toBe(0);
    });

    it('declares every control and disables the format dropdown with the status bar off', async () => {
        const { plugin, tab } = await makeTab();
        const flatten = (items: unknown[]): Record<string, unknown>[] =>
            items.flatMap((item) => {
                const record = item as { items?: unknown[] };
                return record.items ? flatten(record.items) : [item as Record<string, unknown>];
            });
        const controls = flatten(tab.getSettingDefinitions() as unknown[])
            .map(def => def.control as { key?: string; disabled?: () => boolean } | undefined)
            .filter((control): control is { key: string; disabled?: () => boolean } => control?.key !== undefined);
        expect(controls.map(c => c.key)).toEqual([
            'targets.windows', 'targets.linux', 'targets.android', 'targets.ios',
            'windowsPathBudgetOverride', 'showStatusBar', 'statusBarFormat',
        ]);

        const format = controls.find(c => c.key === 'statusBarFormat');
        expect(format?.disabled?.()).toBe(false);
        plugin.settings.showStatusBar = false;
        expect(format?.disabled?.()).toBe(true);
    });
});

describe('notifyIfIncompatible', () => {
    it('shows a notice naming the affected platforms', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        plugin.notifyIfIncompatible(new TFile('CON.md') as never);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('Windows');
    });

    it('announces a file once until its name changes', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        const file = new TFile('CON.md') as never;
        plugin.notifyIfIncompatible(file);
        plugin.notifyIfIncompatible(file);
        expect(notices).toHaveLength(1);

        // A different (still bad) path is its own announcement.
        plugin.notifyIfIncompatible(new TFile('NUL.md') as never);
        expect(notices).toHaveLength(2);
    });

    it('does nothing for a null file or a compatible file', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        plugin.notifyIfIncompatible(null);
        plugin.notifyIfIncompatible(new TFile('fine.md') as never);
        expect(notices).toHaveLength(0);
    });
});
