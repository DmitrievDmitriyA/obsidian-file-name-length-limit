import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: {
            // main.test.ts exercises main.ts outside the app; the real module
            // only exists inside Obsidian.
            obsidian: path.resolve(__dirname, 'obsidian-mock.ts'),
        },
        // Prefer .ts sources: './main' must resolve to main.ts, not the built
        // main.js bundle sitting next to it.
        extensions: ['.ts', '.mjs', '.js', '.json'],
    },
});
