# File Name Length Limit Plugin for Obsidian

## Description
This plugin helps you keep an Obsidian vault compatible across every device you sync it to — Windows, Linux, Android, and iOS. Instead of a single arbitrary limit, you pick the platforms you use and the plugin applies the **strictest combination** of their real filesystem rules: per-name length (in both characters and UTF-8 bytes), full path length, forbidden characters, reserved names, trailing dots/spaces, and case-only collisions. It warns you about the active file and can generate a full report of everything that would break on sync.

### Why this matters
The limits differ by platform and aren't just about character count:

- **Per-name length**: 255 UTF-16 characters on Windows/iOS, but 255 **bytes** on Linux/Android — so a name with emoji or accented characters can pass on one system and fail on another.
- **Full path length**: Windows caps the absolute path at 260 characters; the others are far more generous.
- **Characters & names**: Windows and Android's shared storage reject `< > : " / \ | ? *`, trailing dots/spaces, and reserved names like `CON` or `NUL`. Case-insensitive systems (Windows, iOS) also collide on names that differ only by case.

## Installation
To install the plugin, follow these steps:
1. Download the latest release from the GitHub repository.
2. Extract the files and place them into your Obsidian vault's `.obsidian/plugins` directory.
3. In Obsidian, open Settings → Community Plugins and disable Safe Mode.
4. Find the FileName Length Limit plugin in the list of available plugins and enable it.

## Usage
Open the plugin settings and enable every platform you sync this vault to. The plugin then notifies you whenever the currently active file would be incompatible with one of them.

The status bar shows the active file's length; when the file is incompatible it turns into a highlighted warning. Clicking it generates the report described below.

Run the command **"Check all file names"** to scan the whole vault and generate a report at `FileNameCompatibilityReport.md` in your vault root. Files are sorted by number of issues, each issue names the platform(s) it affects, and case-only collisions are listed separately. Running the command again overwrites the existing report.

## Configuration
Navigate to the plugin settings in Obsidian to configure:

- **Target platforms** — toggle Windows, Linux, Android, and iOS. The strictest combination of the selected platforms' rules is applied.
- **Windows device-path budget** — because Windows measures the *absolute* path (which differs per device), reserve the length of the vault's location on your Windows machine (e.g. `C:\Users\me\Documents\MyVault\`). Only used when Windows is selected. Default is 90.
- **Show status bar indicator** — toggle the status bar warning.

## Contributing
Contributions to the FileName Length Limit plugin are welcome. If you have a suggestion, bug report, or feature request, please open an issue on the GitHub repository. If you're interested in contributing to the codebase, feel free to fork the repository and submit a pull request.
