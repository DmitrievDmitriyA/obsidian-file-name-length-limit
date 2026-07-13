# File name length limit

An [Obsidian](https://obsidian.md) plugin that keeps your vault's file names compatible across every device you sync it to — **Windows, Linux, Android, and iOS**.

Sync a vault between a Windows PC, a Linux server, and a phone and sooner or later a file silently fails to sync, or the whole vault refuses to copy, because a name is too long or contains a character one of those systems rejects. This plugin catches those names *before* they break your sync.

## How it works

You tell the plugin which platforms you sync to. It then applies the **strictest combination** of their real filesystem rules — not one arbitrary number — and flags any file that would break on at least one of them.

It checks each file for:

- **Name length** — every folder and file name against the 255-character-per-name limit, measured in **both** UTF-16 characters (how Windows/iOS count) **and** UTF-8 bytes (how Linux/Android count). A name with emoji or accented characters can be short in characters but too long in bytes.
- **Full path length** — Windows caps the *absolute* path at 260 characters; the plugin accounts for where your vault lives on disk (see [Windows vault path length](#settings)).
- **Forbidden characters** — `< > : " / \ | ? *` and control characters, which Windows and Android's shared storage reject.
- **Reserved names** — Windows refuses names like `CON`, `NUL`, `COM1`, even with an extension.
- **Trailing dots or spaces** — silently stripped or rejected on Windows/Android.
- **Case-only collisions** — `Note.md` and `note.md` coexist on Linux but collide on Windows/iOS.

Every issue in the report names exactly which platform(s) it affects.

## Why per-platform, not a single limit

The limits genuinely differ, and length is only part of the story:

| Rule | Windows | Linux | Android | iOS |
| --- | --- | --- | --- | --- |
| Per-name limit | 255 chars | 255 **bytes** | 255 **bytes** | 255 chars |
| Full path limit | 260 chars | 4096 | 4096 | large |
| Forbidden chars | `< > : " / \ | ? *` | `/` | `< > : " / \ | ? *` | `: /` |
| Reserved names | yes | no | no | no |
| Case-sensitive | no | yes | yes | no |

Selecting only the platforms you actually use avoids false alarms — e.g. if you never touch Windows, long paths and reserved names stop being flagged.

## Usage

- **Automatic warning** — open or rename a file and, if it's incompatible with one of your selected platforms, you get a notice naming the platforms and the number of issues.
- **Status bar** — shows the active file's length, and turns into a highlighted `⚠` warning when the file is incompatible. Click it to run a full scan.
- **Full report** — run the command **"Check all file names"** (from the command palette) to scan the whole vault. It writes `FileNameCompatibilityReport.md` to your vault root: files sorted by number of issues, each issue attributed to the platform(s) it affects, plus a section listing case-only collisions. Re-running overwrites the report.

## Settings

- **Target platforms** — toggle Windows, Linux, Android, and iOS. The strictest combination of the selected platforms is applied.
- **Windows vault path length** — Windows measures the full *absolute* path, which includes your vault's location (e.g. `C:\Users\me\Documents\MyVault\`). On desktop the plugin **auto-detects** this and shows the value; leave the field blank to use it. Enter a number only to override — useful if another Windows device you sync to has a longer path. Only used when Windows is selected.
- **Show status bar indicator** — toggle the status bar length/warning.

## Privacy

The plugin works entirely offline and makes **no network requests** — no telemetry, no analytics, no external services. The "Check all file names" command reads the **names and paths** of files in your vault (never their contents) to check them against the selected platforms, and writes its findings only to `FileNameCompatibilityReport.md` inside your vault. On desktop it also reads your vault's own folder path to estimate the Windows path limit; that value never leaves your device.

## Installation

### From Obsidian (once approved)

1. Open **Settings → Community plugins** and turn off Restricted mode.
2. Click **Browse**, search for **"File name length limit"**, and install.
3. Enable the plugin.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/DmitrievDmitriyA/obsidian-file-name-length-limit/releases/latest).
2. Copy them into `<YourVault>/.obsidian/plugins/file-name-length-limit/`.
3. Reload Obsidian and enable the plugin under **Settings → Community plugins**.

## Contributing

Issues and pull requests are welcome. See [DEVELOPMENT.md](DEVELOPMENT.md) for how to build, run, and release the plugin locally.

## License

[MIT](LICENSE) © Dmitrii Dmitriev
