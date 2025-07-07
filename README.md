# npm-workspaces-publish-tool

A CLI tool for automating npm package publishing in monorepositories. This tool handles dependency resolution, version validation, build sequencing, and safe publishing with workspace dependency management. Note this is designed for use
for mono-repos and will not work for projects without npm workspaces.

## Features

- Automatic dependency graph analysis (topological sorting)
- Smart change detection since last release
- Version validation and increment checking
- Git status verification (prevents publishing with uncommitted changes)
- Workspace dependency management (converts `*` dependencies to exact versions during publish)
- Dry run mode for testing publish workflow
- Build sequencing in dependency order
- Safe rollback of package.json files after publishing

## Installation

```bash
npm install -g npm-workspaces-publish-tool
```

## Usage

```bash
nw-publish [--dry-run]
```

### Command Options

- `--dry-run`: Runs validation and preview without actual publishing

## Workflow
1. **Validation Phase**
   - Builds packages in dependency order
   - Verifies all modified packages have incremented versions
   - Ensures git status is clean
   - Checks for unpushed commits

2. **Publishing Phase**
   - Replaces workspace `*` dependencies with exact versions
   - Publishes packages in topological order
   - Restores original `package.json` files after publishing

## Requirements
- Node.js 16+
- Git
- npm workspaces monorepo structure
- All packages must have valid `semver` versions
- Build scripts defined in `package.json` (if needed)

## License
MIT © Jonathan Kelsey
