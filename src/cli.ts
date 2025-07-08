#!/usr/bin/env node
import { program } from 'commander';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, relative, resolve } from 'path';
import { cwd as getCwd } from 'process';
import { PackageJson } from 'type-fest';
import semver from 'semver';
import {
    createDependencyMap,
    getChangesBetweenRefs,
    getPackageInfos,
    getWorkspaces,
    git,
    PackageInfos,
    WorkspaceInfo,
} from 'workspace-tools';
import { execSync } from 'child_process';
import { homedir } from 'os';

type Workspace = ReturnType<typeof getWorkspaces>[number];
type Dependencies = Set<string>;
type DirtyStatus = 'new' | 'dirty' | 'unchanged';
type WorkspaceIssue = {
    unstagedFiles: string[];
    stagedFiles: string[];
    untrackedFiles: string[];
};

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const cwd = getCwd();
const dependancyTypes = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
];

function getLastTag(cwd: string): string | null {
    const result = git(['tag', '--list', 'v*', '--sort=-v:refname'], { cwd });
    if (!result.success) return null;
    const tags = result.stdout.split('\n').filter(Boolean);
    return tags[0] || null;
}

function calculateWorkspaceInDegree(
    workspaces: WorkspaceInfo,
    dependencies: Map<string, Set<string>>
) {
    const inDegree = new Map<string, number>();

    for (const pkgName of workspaces.map((workspace) => workspace.name)) {
        inDegree.set(pkgName, 0);
    }

    for (const [pkgName, deps] of dependencies) {
        for (const _ of deps) {
            inDegree.set(pkgName, (inDegree.get(pkgName) ?? 0) + 1);
        }
    }

    return inDegree;
}

function getReleaseOrderFromInDegree(
    inDegree: Map<string, number>,
    dependencies: Map<string, Set<string>>
): string[] {
    const queue = Array.from(inDegree.entries())
        .filter(([_, count]) => count === 0)
        .map(([pkg]) => pkg);

    const order: string[] = [];

    while (queue.length > 0) {
        const current = queue.shift() as string;
        order.push(current);

        for (const [pkg, deps] of dependencies) {
            if (deps.has(current)) {
                const newCount = (inDegree.get(pkg) as number) - 1;
                inDegree.set(pkg, newCount);
                if (newCount === 0) {
                    queue.push(pkg);
                }
            }
        }
    }

    return order;
}

function getDirtyMap(
    workspaces: ReturnType<typeof getWorkspaces>,
    lastTag: string | null,
    cwd: string,
): Map<string, DirtyStatus> {
    const dirtyMap = new Map<string, DirtyStatus>();

    const changedFiles = lastTag
        ? getChangesBetweenRefs(lastTag, 'HEAD', [], '', cwd)
        : [];

    for (const ws of workspaces) {
        const isNew = !lastTag;
        const isDirty = changedFiles.some((f) => resolve(cwd,f).includes(ws.path));

        if (isNew) {
            dirtyMap.set(ws.name, 'new');
        } else if (isDirty) {
            dirtyMap.set(ws.name, 'dirty');
        } else {
            dirtyMap.set(ws.name, 'unchanged');
        }
    }

    return dirtyMap;
}

function getDirtyPackagesVersionChanges(
    workspaces: ReturnType<typeof getWorkspaces>,
    dirtyMap: Map<string, DirtyStatus>,
    lastTag: string | null,
    cwd: string
): Map<
    string,
    {
        oldVersion: string | null;
        newVersion: string;
        versionChanged: boolean;
        versionIncremented: boolean;
    }
> {
    const result = new Map<
        string,
        {
            oldVersion: string | null;
            newVersion: string;
            versionChanged: boolean;
            versionIncremented: boolean;
        }
    >();

    if (!lastTag) {
        for (const ws of workspaces) {
            const status = dirtyMap.get(ws.name);
            if (status !== 'dirty' && status !== 'new') continue;

            const pkgPath = resolve(cwd, ws.path, 'package.json');
            let currentPkg: PackageJson;
            try {
                currentPkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
            } catch (err) {
                throw new Error(
                    `Failed to parse current package.json for package "${ws.name}" at path "${pkgPath}": ${err}`
                );
            }

            const newVersion = currentPkg.version as string;
            result.set(ws.name, {
                oldVersion: null,
                newVersion,
                versionChanged: true,
                versionIncremented: true,
            });
        }
        return result;
    }

    for (const ws of workspaces) {
        const status = dirtyMap.get(ws.name);
        if (status !== 'dirty' && status !== 'new') continue;

        const pkgPath = resolve(cwd, ws.path, 'package.json');

        let currentPkg: PackageJson;
        try {
            currentPkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
        } catch (err) {
            throw new Error(
                `Failed to parse current package.json for package "${ws.name}" at path "${pkgPath}": ${err}`
            );
        }

        const newVersion = currentPkg.version as string;

        if (status === 'new') {
            result.set(ws.name, {
                oldVersion: null,
                newVersion,
                versionChanged: true,
                versionIncremented: true,
            });
            continue;
        }

        const relativeWsPath = relative(cwd, ws.path);

        const previousPkgRaw = git(
            ['show', `${lastTag}:${relativeWsPath}/package.json`],
            {
                cwd,
            }
        );

        if (!previousPkgRaw.success) {
            result.set(ws.name, {
                oldVersion: null,
                newVersion,
                versionChanged: true,
                versionIncremented: true,
            });
            continue;
        }

        let previousPkg: PackageJson;
        try {
            previousPkg = JSON.parse(previousPkgRaw.stdout);
        } catch (err) {
            throw new Error(
                `Failed to parse package.json from git at tag "${lastTag}" for package "${ws.name}": ${err}`
            );
        }

        const oldVersion = previousPkg.version as string;
        const versionChanged = newVersion !== oldVersion;
        const versionIncremented = semver.gt(newVersion, oldVersion);

        result.set(ws.name, {
            oldVersion,
            newVersion,
            versionChanged,
            versionIncremented,
        });
    }

    return result;
}

function checkForUnpushedCommits(cwd: string) {
    const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    if (!branchResult.success) {
        console.error('ERROR: Could not determine current branch.');
        return false;
    }

    const currentBranch = branchResult.stdout.trim();
    if (currentBranch === 'HEAD') {
        console.error(
            'ERROR: You are in detached HEAD state. Cannot check for unpushed commits.'
        );
        return false;
    }

    const upstreamResult = git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd });
    if (!upstreamResult.success) {
        console.error(
            `ERROR: Current branch '${currentBranch}' has no upstream set.`
        );
        console.error(
            'Please set upstream with: git branch --set-upstream-to=origin/<branch>'
        );
        return false;
    }

    const upstream = upstreamResult.stdout.trim();
    const unpushed = git(['log', `${upstream}..HEAD`, '--oneline'], { cwd });

    if (unpushed.stdout.trim() !== '') {
        console.error('ERROR: You have committed but unpushed changes:');
        console.error(unpushed.stdout);
        console.error(
            `Please push your changes to '${upstream}' before publishing.`
        );
        return false;
    }

    return true;
}

function verifyCleanGitStatus(
    workspaces: { name: string; path: string }[],
    dirtyMap: Map<string, 'new' | 'dirty' | 'unchanged'>,
    cwd: string
): boolean {
    const changedFilesRaw = git(['diff', '--name-only', 'HEAD'], { cwd })
        .stdout.trim()
        .split('\n')
        .filter(Boolean);

    const stagedFilesRaw = git(['diff', '--cached', '--name-only'], { cwd })
        .stdout.trim()
        .split('\n')
        .filter(Boolean);

    const unstagedFilesRaw = git(['diff', '--name-only'], { cwd })
        .stdout.trim()
        .split('\n')
        .filter(Boolean);

    const status = git(['status', '--porcelain'], { cwd })
        .stdout.trim()
        .split('\n')
        .filter(Boolean);
    const untrackedFilesRaw = status
        .filter((line) => line.startsWith('??'))
        .map((line) => line.slice(3));

    const workspaceIssues = new Map<string, WorkspaceIssue>();

    for (const ws of workspaces) {
        workspaceIssues.set(ws.name, {
            unstagedFiles: [],
            stagedFiles: [],
            untrackedFiles: [],
        });
    }

    function findWorkspaceForFile(filePath: string) {
        const absoluteFilePath = resolve(cwd, filePath).replace(/\\/g, '/');

        for (const ws of workspaces) {
            const wsPathNormalized = resolve(cwd, ws.path)
                .replace(/\\/g, '/')
                .replace(/\/$/, '');

            if (
                absoluteFilePath === wsPathNormalized ||
                absoluteFilePath.startsWith(wsPathNormalized + '/')
            ) {
                return ws;
            }
        }

        return undefined;
    }

    const changedFiles = new Set(changedFilesRaw);
    const stagedFiles = new Set(stagedFilesRaw);
    const unstagedFiles = new Set(unstagedFilesRaw);

    for (const filePath of changedFiles) {
        const ws = findWorkspaceForFile(filePath);
        if (!ws) continue;

        const status = dirtyMap.get(ws.name);
        if (status !== 'new' && status !== 'dirty') continue;

        const issues = workspaceIssues.get(ws.name) as WorkspaceIssue;

        if (unstagedFiles.has(filePath)) {
            issues.unstagedFiles.push(filePath);
        } else if (stagedFiles.has(filePath)) {
            issues.stagedFiles.push(filePath);
        }
    }

    for (const filePath of untrackedFilesRaw) {
        const ws = findWorkspaceForFile(filePath);
        if (!ws) continue;
        if (
            dirtyMap.get(ws.name) !== 'new' &&
            dirtyMap.get(ws.name) !== 'dirty'
        )
            continue;

        (workspaceIssues.get(ws.name) as WorkspaceIssue).untrackedFiles.push(
            filePath
        );
    }

    let hasCriticalIssues = false;

    for (const [wsName, issues] of workspaceIssues.entries()) {
        const { unstagedFiles, stagedFiles, untrackedFiles } = issues;
        const status = dirtyMap.get(wsName);

        // Skip workspaces without issues
        if (
            unstagedFiles.length === 0 &&
            stagedFiles.length === 0 &&
            untrackedFiles.length === 0
        ) {
            continue;
        }

        let workspaceHasCriticalIssues = false;
        const workspaceWarnings: string[] = [];

        if (unstagedFiles.length > 0) {
            workspaceHasCriticalIssues = true;
        }

        if (stagedFiles.length > 0) {
            workspaceHasCriticalIssues = true;
        }

        // Handle untracked files
        if (untrackedFiles.length > 0) {
            let hasCriticalUntracked = false;

            for (const f of untrackedFiles) {
                if (f.includes('package.json')) {
                    hasCriticalUntracked = true;
                }
            }

            if (status === 'new') {
                // All untracked files are critical for new workspaces
                workspaceHasCriticalIssues = true;
            } else if (hasCriticalUntracked) {
                // Untracked package.json is always critical
                workspaceHasCriticalIssues = true;
            } else if (status === 'dirty') {
                // Non-package.json untracked files are warnings
                workspaceWarnings.push(...untrackedFiles);
            }
        }

        if (workspaceHasCriticalIssues) {
            hasCriticalIssues = true;
            console.error(
                `Workspace '${wsName}' has critical issues preventing publish:`
            );

            if (unstagedFiles.length > 0) {
                console.error('  ❌ Unstaged files:');
                for (const f of unstagedFiles) {
                    console.error(`    - ${f}`);
                }
            }

            if (stagedFiles.length > 0) {
                console.error('  ❌ Staged but uncommitted files:');
                for (const f of stagedFiles) {
                    console.error(`    - ${f}`);
                }
            }

            if (untrackedFiles.length > 0) {
                console.error('  ❌ Critical untracked files:');
                for (const f of untrackedFiles) {
                    // Only show package.json files as critical
                    if (f.includes('package.json')) {
                        console.error(`    - ${f} (must be committed)`);
                    } else if (status === 'new') {
                        console.error(
                            `    - ${f} (new workspace must commit all files)`
                        );
                    }
                }
            }
        }

        // Show non-critical warnings
        if (workspaceWarnings.length > 0) {
            console.warn(`⚠️  Workspace '${wsName}' has non-critical issues:`);
            console.warn(
                '  Untracked files (allowed but should be in .gitignore):'
            );
            for (const f of workspaceWarnings) {
                console.warn(`    - ${f}`);
            }
        }
    }

    const rootPackageJsonPath = 'package.json';
    if (changedFiles.has(rootPackageJsonPath)) {
        if (unstagedFiles.has(rootPackageJsonPath)) {
            console.error(
                `❌ Root package.json has unstaged changes. Please stage or discard them.`
            );
            hasCriticalIssues = true;
        }
        if (stagedFiles.has(rootPackageJsonPath)) {
            console.error(
                `❌ Root package.json is staged but not committed. Please commit it.`
            );
            hasCriticalIssues = true;
        }
    }

    if (hasCriticalIssues) {
        console.error(
            'Please commit or stash the above changes before publishing.'
        );
        return false;
    }

    if (!checkForUnpushedCommits(cwd)) {
        return false;
    }

    return true;
}

function validatePublish() {
    const lastMonoRepoTag = getLastTag(cwd);
    const workspaces = getWorkspaces(cwd);
    const packageInfos = getPackageInfos(cwd);
    const { dependencies } = createDependencyMap(packageInfos);
    const inDegree = calculateWorkspaceInDegree(workspaces, dependencies);
    const releaseOrder = getReleaseOrderFromInDegree(inDegree, dependencies);
    const dirtyMap = getDirtyMap(workspaces, lastMonoRepoTag, cwd);
    const dirtyVersionChanges = getDirtyPackagesVersionChanges(
        workspaces,
        dirtyMap,
        lastMonoRepoTag,
        cwd
    );

    console.log('🏗️  Building packages...');
    for (const pkgName of releaseOrder) {
        const pkgInfo = packageInfos[pkgName];
        if (!pkgInfo.scripts?.build) continue;

        const pkgDir = dirname(pkgInfo.packageJsonPath);
        console.log(`\n🏗️  Building ${pkgName}...`);
        try {
            execSync('npm run build', {
                cwd: pkgDir,
                stdio: 'inherit',
                env: { ...process.env, FORCE_COLOR: '1' },
            });
        } catch (error) {
            console.error(`❌ Build failed for ${pkgName}:`, error);
            process.exit(1);
        }
    }

    console.log('\n#️⃣  Validating versions...\n');

    let hasError = false;

    // Validate workspace versions
    for (const [
        pkgName,
        { oldVersion, newVersion, versionChanged, versionIncremented },
    ] of dirtyVersionChanges.entries()) {
        if (!semver.valid(newVersion)) {
            console.error(
                `❌ Package "${pkgName}" has invalid version: "${newVersion}"`
            );
            hasError = true;
            continue;
        }

        if (!versionChanged) {
            console.error(
                `❌ Package "${pkgName}" was modified but version unchanged (${newVersion})`
            );
            hasError = true;

            const ws = workspaces.find((w) => w.name === pkgName) as Workspace;
            const changedFiles = lastMonoRepoTag
                ? getChangesBetweenRefs(
                      lastMonoRepoTag,
                      'HEAD',
                      [],
                      ws.path,
                      cwd
                  )
                : [];

            if (changedFiles.length > 0) {
                console.error(`   Changed files in "${pkgName}":`);
                for (const file of changedFiles) {
                    console.error(`     - ${relative(ws.path, file)}`);
                }
            }
            continue;
        }

        if (oldVersion && !versionIncremented) {
            console.error(
                `❌ Package "${pkgName}" version not incremented: ${oldVersion} -> ${newVersion}`
            );
            hasError = true;
        }
    }

    // Validate root workspace
    const rootPackageJsonPath = resolve(cwd, 'package.json');
    let previousRootVersion: string | undefined;
    let currentRootVersion: string | undefined;
    let rootPackageSuccessMessage: string | undefined;
    try {
        const rootPackage = JSON.parse(
            readFileSync(rootPackageJsonPath, 'utf8')
        ) as PackageJson;
        currentRootVersion = rootPackage.version;

        // Ensure the root version string itself is valid semver
        if (!semver.valid(currentRootVersion)) {
            console.error(
                `❌ Invalid root version in package.json: "${currentRootVersion}"`
            );
            hasError = true;
        } else if (lastMonoRepoTag) {
            const lastRootPackageRaw = git(
                ['show', `${lastMonoRepoTag}:package.json`],
                { cwd }
            );
            if (lastRootPackageRaw.success) {
                try {
                    const lastRootPackage = JSON.parse(
                        lastRootPackageRaw.stdout
                    ) as PackageJson;
                    previousRootVersion = lastRootPackage.version as string;

                    // Ensure the root version has been incremented
                    if (
                        !semver.gt(
                            currentRootVersion as string,
                            previousRootVersion
                        )
                    ) {
                        console.error(
                            `❌ Root version not incremented: ${previousRootVersion} → ${currentRootVersion}`
                        );
                        hasError = true;
                    } else {
                        rootPackageSuccessMessage = `🌳 Root: ${lastRootPackage.version} → ${currentRootVersion}`;
                    }
                } catch {
                        rootPackageSuccessMessage =`⚠️ Root: ${currentRootVersion} (previous version unavailable)`
                }
            } else {
                    rootPackageSuccessMessage = `⚠️ Root: ${currentRootVersion} (previous version unavailable)`
            }
        } else {
            rootPackageSuccessMessage = `🌳 Root: ${currentRootVersion} (first release)`;
        }
    } catch (e) {
        console.error(
            `❌ Could not parse root package.json "${rootPackageJsonPath}"\n${String(
                (e as Error).stack
            )}`
        );
        hasError = true;
    }

    if (hasError) {
        console.error('\nFix the above issues before publishing.\n');
        process.exit(1);
    }

    console.log(rootPackageSuccessMessage);

    console.log('\n🗃️  Validating git status...\n');

    if (!verifyCleanGitStatus(workspaces, dirtyMap, cwd)) {
        process.exit(1);
    }

    console.log('📝 Publish summary:\n');

    if (previousRootVersion) {
        console.log(`🌳 Root: ${previousRootVersion} → ${currentRootVersion}`);
    } else {
        console.log(`🌳 Root: ${currentRootVersion} (first release)`);
    }
    console.log('');

    const packagesToRelease: string[] = [];

    for (const pkgName of releaseOrder) {
        const status = dirtyMap.get(pkgName);
        const versionInfo = dirtyVersionChanges.get(pkgName);

        if (status === 'new') {
            packagesToRelease.push(pkgName);
            const ws = workspaces.find((w) => w.name === pkgName);
            if (!ws) continue;
            const currentVersion = JSON.parse(
                readFileSync(resolve(cwd, ws.path, 'package.json'), 'utf8')
            ).version;
            console.log(`🆕 ${pkgName} @ ${currentVersion} (new)`);
        } else if (status === 'dirty' && versionInfo?.versionIncremented) {
            packagesToRelease.push(pkgName);
            console.log(
                `⬆️ ${pkgName}: ${versionInfo.oldVersion} → ${versionInfo.newVersion}`
            );
        } else {
            const ws = workspaces.find((w) => w.name === pkgName);
            if (!ws) continue;
            const currentVersion = JSON.parse(
                readFileSync(resolve(cwd, ws.path, 'package.json'), 'utf8')
            ).version;
            console.log(`✔️ ${pkgName} @ ${currentVersion} (unchanged)`);
        }
    }

    return {
        releaseOrder,
        packageInfos,
        packagesToRelease,
        currentRootVersion: currentRootVersion as string,
    };
}

function replaceWorkspaceDepsWithVersions(
    packageInfos: PackageInfos,
    packagesToUpdate: string[]
): Map<string, string> {
    const originals = new Map<string, string>();

    for (const pkgName of packagesToUpdate) {
        const pkgInfo = packageInfos[pkgName];
        const packageJsonPath = pkgInfo.packageJsonPath;
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

        originals.set(pkgName, JSON.stringify(packageJson));

        let changed = false;

        for (const depType of dependancyTypes) {
            const deps = packageJson[depType];
            if (!deps) continue;

            for (const [depName, currentSpec] of Object.entries<string>(deps)) {
                if (currentSpec === '*' && packageInfos[depName]) {
                    const newVersion = packageInfos[depName].version;
                    deps[depName] = newVersion;
                    changed = true;
                    console.log(
                        `🆙 Updated ${pkgName}'s ${depType} for ${depName} to ${newVersion}`
                    );
                }
            }
        }

        if (changed) {
            writeFileSync(
                packageJsonPath,
                JSON.stringify(packageJson, null, 4)
            );
        }
    }

    return originals;
}

function restoreWorkspaceDepsToStar(
    packageInfos: PackageInfos,
    packagesToRestore: string[],
    originals: Map<string, string>
) {
    for (const pkgName of packagesToRestore) {
        const original = originals.get(pkgName);
        if (original) {
            const pkgInfo = packageInfos[pkgName];
            writeFileSync(pkgInfo.packageJsonPath, original);
            console.log(`♻️ Restored dependencies for ${pkgName}`);
        }
    }
}

function runNpmPublishInReleaseOrder(
    releaseOrder: string[],
    packageInfos: PackageInfos,
    packagesToRelease: string[],
    registryUrl?: string
) {
    // Determine the registry flag to pass; fallback to ~/.npmrc if no explicit URL
    let registryFlag = '';
    if (registryUrl) {
        registryFlag = ` --registry=${registryUrl}`;
    } else {
        const homeNpmrc = `${homedir()}/.npmrc`;
        if (existsSync(homeNpmrc)) {
            const lines = readFileSync(homeNpmrc, 'utf8').split(/\r?\n/);
            const line = lines.find((l) => l.trim().startsWith('registry='));
            if (line) {
                const url = line.split('=')[1].trim();
                registryFlag = ` --registry=${url}`;
            }
        }
    }

    for (const packageName of releaseOrder) {
        if (!packagesToRelease.includes(packageName)) continue;

        const pkgInfo = packageInfos[packageName];
        const pkgDir = dirname(pkgInfo.packageJsonPath);
        console.log(
            `\n📦 Publishing ${packageName} from ${pkgDir} to ${
                registryUrl || 'default registry'
            }...`
        );

        try {
            execSync(`npm publish${registryFlag}`, {
                cwd: pkgDir,
                stdio: 'inherit',
                env: { ...process.env, FORCE_COLOR: '1' },
            });
            console.log(`✅ Successfully published ${packageName}`);
        } catch (error) {
            console.error(`❌ Failed to publish ${packageName}:`, error);
            throw error;
        }
    }
}

function tagAndPushRepo(version: string) {
    try {
        execSync(`git tag v${version}`, { stdio: 'inherit' });
        execSync(`git push origin v${version}`, { stdio: 'inherit' });
        console.log(`✅ Tagged and pushed v${version}`);
    } catch (err) {
        console.error(`❌ Failed to tag or push v${version}:`, err);
        process.exit(1);
    }
}

function printHeader() {
    console.log(`
                             _    _  _      _   
                            ( )  ( )(_)    ( )  
 ____  _ _ _  ___  ___  _ _ | |_ | | _  __ | |_ 
( __ )( V V )(___)( o \\( U )( o \\( )( )(_' ( _ )
/_\\/_\\ \\_^_/      / __//___\\/___//_\\/_\\/__)/_\\||
                  |_|  
`);
    console.log(
        `🚀 ${pkg.name} v${pkg.version} - Npm Monorepo Publishing Suite\n`
    );
}

program.name(pkg.name).description(pkg.description).version(pkg.version);

program
    .description('Publish packages')
    .option('--dry-run', 'Run without making changes')
    .option('--registry <url>', 'NPM registry to publish to')
    .action((options) => {
        printHeader();
        const {
            packageInfos,
            releaseOrder,
            packagesToRelease,
            currentRootVersion,
        } = validatePublish();
        const dryRun = options.dryRun;
        const registryUrl = options.registry;

        if (packagesToRelease.length === 0) {
            return console.log(' ￣\\_(ツ)_/￣ No workspaces to publish');
        }

        let originalPackageJsons: Map<string, string> | null = null;

        try {
            if (!dryRun) {
                console.log(
                    '\n🆙 Updating workspace dependencies to exact versions...'
                );
                originalPackageJsons = replaceWorkspaceDepsWithVersions(
                    packageInfos,
                    packagesToRelease
                );
            } else {
                console.log(
                    '\n[dry-run] 🆙 Would update workspace dependencies to exact versions'
                );
            }

            if (!dryRun) {
                console.log('\n📦 Publishing packages...');
                runNpmPublishInReleaseOrder(
                    releaseOrder,
                    packageInfos,
                    packagesToRelease,
                    registryUrl
                );
                console.log('\n🎉 All packages published successfully!');
                console.log(
                    `\n🏷️ Tagging repository with v${currentRootVersion}...`
                );
                tagAndPushRepo(currentRootVersion);
            } else {
                console.log('\n[dry-run] 📦 Would publish packages in order:');
                packagesToRelease.forEach((pkg) => console.log(`- ${pkg}`));
                console.log(
                    `\n[dry-run] 🏷️  Would tag repository with v${currentRootVersion}...`
                );
            }
        } catch (error) {
            console.error('\n ❌ Publishing failed:', error);
            process.exit(1);
        } finally {
            if (!dryRun && originalPackageJsons) {
                console.log('\n♻️ Restoring workspace dependencies...');
                restoreWorkspaceDepsToStar(
                    packageInfos,
                    packagesToRelease,
                    originalPackageJsons
                );
                console.log('♻️ Restoration complete.');
            } else if (dryRun) {
                console.log(
                    '\n[dry-run] ♻️ Would restore workspace dependencies'
                );
            }
        }
    });

program.parse(process.argv);
