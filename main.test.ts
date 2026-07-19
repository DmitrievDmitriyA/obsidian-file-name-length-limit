// Integration tests for the Obsidian glue in main.ts, run against the mocked
// `obsidian` module (see vitest.config.ts). Covers what the analyzer unit tests
// cannot: settings loading/migration, budget auto-detection, report writing,
// and user-facing notices.

import { beforeEach, describe, expect, it } from 'vitest';
import FileNameLengthLimitPlugin from './main';
import { FileSystemAdapter, notices, TFile } from './obsidian-mock';

interface TestVault {
    files: TFile[];
    adapter: unknown;
    created: Map<string, TFile>;
    contents: Map<string, string>;
    createCalls: number;
    modifyCalls: number;
}

function makePlugin(options: { files?: string[]; adapter?: unknown; stored?: unknown } = {}) {
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

    const workspace = { on() {}, getActiveFile: () => null };
    const plugin = new FileNameLengthLimitPlugin({ vault, workspace } as never, {} as never);
    if (options.stored !== undefined) {
        (plugin as unknown as { __setStoredData(d: unknown): void }).__setStoredData(options.stored);
    }
    return { plugin, vaultState };
}

beforeEach(() => {
    notices.length = 0;
});

describe('loadSettings', () => {
    it('uses defaults when nothing is stored', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        expect(plugin.settings.targets).toEqual({ windows: true, linux: true, android: true, ios: true });
        expect(plugin.settings.windowsPathBudgetOverride).toBe(0);
        expect(plugin.settings.showStatusBar).toBe(true);
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

describe('notifyIfIncompatible', () => {
    it('shows a notice naming the affected platforms', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        plugin.notifyIfIncompatible(new TFile('CON.md') as never);
        expect(notices).toHaveLength(1);
        expect(notices[0]).toContain('Windows');
    });

    it('does nothing for a null file or a compatible file', async () => {
        const { plugin } = makePlugin();
        await plugin.loadSettings();
        plugin.notifyIfIncompatible(null);
        plugin.notifyIfIncompatible(new TFile('fine.md') as never);
        expect(notices).toHaveLength(0);
    });
});
