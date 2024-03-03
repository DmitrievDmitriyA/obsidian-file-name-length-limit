# File Name Length Limit Plugin for Obsidian

## Description
This plugin for Obsidian helps users manage the length of their file names. It provides a customizable limit to the length of file names and offers functionalities to notify users when a file exceeds this limit. It also includes a feature to generate a report of all files in the vault that exceed the specified length limit.

## Installation
To install the plugin, follow these steps:
1. Download the latest release from the GitHub repository.
2. Extract the files and place them into your Obsidian vault's `.obsidian/plugins` directory.
3. In Obsidian, open Settings → Community Plugins and disable Safe Mode.
4. Find the FileName Length Limit plugin in the list of available plugins and enable it.

## Usage
After installation, you can set the desired maximum file name length in the plugin settings. The plugin will automatically notify you if the name of the currently active file exceeds this limit. 

You can also use the command "Check All File Names" to generate a report of all files with names exceeding the set limit. This report will be saved as `FilesWithTooLongNames.md` in your vault's root directory.

## Configuration
Navigate to the plugin settings in Obsidian to configure the maximum file length. The default limit is set to 255 characters but can be adjusted to suit your needs.

## Contributing
Contributions to the FileName Length Limit plugin are welcome. If you have a suggestion, bug report, or feature request, please open an issue on the GitHub repository. If you're interested in contributing to the codebase, feel free to fork the repository and submit a pull request.
