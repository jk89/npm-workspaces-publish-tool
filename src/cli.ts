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

/**
 * Get which workspaces have meaningful changes since last tag
 * A workspace is "dirty" if:
 * 1. Source files changed (non-package.json files), OR
 * 2. package.json changed in ways OTHER than just version field
 */
function getDirtyMap(
    workspaces: ReturnType<typeof getWorkspaces>,
    lastTag: string | null,
    cwd: string
): Map<string, DirtyStatus> {
    const dirtyMap = new Map<string, DirtyStatus>();

    const changedFilesFromTag = lastTag
        ? getChangesBetweenRefs(lastTag, 'HEAD', [], '', cwd)
        : [];

    for (const ws of workspaces) {
        if (!lastTag) {
            dirtyMap.set(ws.name, 'new');
            continue;
        }

        // Check for source file changes (non-package.json files)
        const sourceFilesChanged = changedFilesFromTag.some((f) => {
            const absoluteFilePath = resolve(cwd, f).replace(/\\/g, '/');
            const absoluteWorkspacePath = resolve(cwd, ws.path).replace(
                /\\/g,
                '/'
            );
            const fileName = f.split('/').pop();

            const isInWorkspace =
                absoluteFilePath.startsWith(absoluteWorkspacePath + '/') ||
                absoluteFilePath === absoluteWorkspacePath;
            const isNotPackageJson =
                fileName !== 'package.json' && fileName !== 'package-lock.json';

            return isInWorkspace && isNotPackageJson;
        });

        // Check if package.json changed in meaningful ways (not just version)
        let packageJsonMeaningfullyChanged = false;
        const workspacePackageJsonPath = resolve(
            cwd,
            ws.path,
            'package.json'
        ).replace(/\\/g, '/');
        const pkgJsonChanged = changedFilesFromTag.some((f) => {
            const absoluteFilePath = resolve(cwd, f).replace(/\\/g, '/');
            return absoluteFilePath === workspacePackageJsonPath;
        });

        if (pkgJsonChanged) {
            // Compare package.json at tag vs now, ignoring version field
            const relativeWsPath = relative(cwd, ws.path);
            const previousPkgRaw = git(
                ['show', `${lastTag}:${relativeWsPath}/package.json`],
                { cwd }
            );

            if (previousPkgRaw.success) {
                try {
                    const previousPkg = JSON.parse(previousPkgRaw.stdout);
                    const currentPkg = JSON.parse(
                        readFileSync(workspacePackageJsonPath, 'utf8')
                    );

                    // Remove version field and compare
                    const prevWithoutVersion = { ...previousPkg };
                    const currWithoutVersion = { ...currentPkg };
                    delete prevWithoutVersion.version;
                    delete currWithoutVersion.version;

                    if (
                        JSON.stringify(prevWithoutVersion) !==
                        JSON.stringify(currWithoutVersion)
                    ) {
                        packageJsonMeaningfullyChanged = true;
                    }
                } catch {
                    // If we can't parse, assume it changed meaningfully
                    packageJsonMeaningfullyChanged = true;
                }
            }
        }

        const isDirty = sourceFilesChanged || packageJsonMeaningfullyChanged;

        if (isDirty) {
            dirtyMap.set(ws.name, 'dirty');
        } else {
            dirtyMap.set(ws.name, 'unchanged');
        }
    }

    return dirtyMap;
}

function checkForUnpushedCommits(cwd: string): boolean {
    const branchResult = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    if (!branchResult.success) {
        console.error('ERROR: Could not determine current branch.');
        return false;
    }

    const currentBranch = branchResult.stdout.trim();
    if (currentBranch === 'HEAD') {
        console.error('ERROR: You are in detached HEAD state.');
        return false;
    }

    const upstreamResult = git(['rev-parse', '--abbrev-ref', '@{u}'], { cwd });
    if (!upstreamResult.success) {
        console.error(`ERROR: Branch '${currentBranch}' has no upstream.`);
        return false;
    }

    const upstream = upstreamResult.stdout.trim();
    const unpushed = git(['log', `${upstream}..HEAD`, '--oneline'], { cwd });

    if (unpushed.stdout.trim() !== '') {
        console.error('ERROR: You have unpushed commits:');
        console.error(unpushed.stdout);
        console.error(`Please push to '${upstream}' before publishing.`);
        return false;
    }

    return true;
}

/**
 * Check git status for uncommitted changes
 */
function checkGitStatus(
    workspaces: ReturnType<typeof getWorkspaces>,
    dirtyMap: Map<string, DirtyStatus>,
    cwd: string,
    dryRun: boolean,
    autoTick: boolean
): boolean {
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

    const stagedFiles = new Set(stagedFilesRaw);
    const unstagedFiles = new Set(unstagedFilesRaw);
    const changedFiles = new Set([...stagedFilesRaw, ...unstagedFilesRaw]);

    function findWorkspaceForFile(filePath: string) {
        const absoluteFilePath = resolve(cwd, filePath).replace(/\\/g, '/');
        for (const ws of workspaces) {
            const wsPathNormalized = resolve(cwd, ws.path).replace(/\\/g, '/');
            if (
                absoluteFilePath.startsWith(wsPathNormalized + '/') ||
                absoluteFilePath === wsPathNormalized
            ) {
                return ws;
            }
        }
        return undefined;
    }

    const workspaceIssues = new Map<string, WorkspaceIssue>();
    for (const ws of workspaces) {
        workspaceIssues.set(ws.name, {
            unstagedFiles: [],
            stagedFiles: [],
            untrackedFiles: [],
        });
    }

    // Populate workspace issues - check ALL workspaces, not just dirty ones
    for (const filePath of changedFiles) {
        const ws = findWorkspaceForFile(filePath);
        if (!ws) continue;

        const issues = workspaceIssues.get(ws.name)!;
        if (unstagedFiles.has(filePath)) {
            issues.unstagedFiles.push(filePath);
        } else if (stagedFiles.has(filePath)) {
            issues.stagedFiles.push(filePath);
        }
    }

    for (const filePath of untrackedFilesRaw) {
        const ws = findWorkspaceForFile(filePath);
        if (!ws) continue;
        workspaceIssues.get(ws.name)!.untrackedFiles.push(filePath);
    }

    // Check for issues
    let hasCriticalIssues = false;

    // Check root package.json
    if (changedFiles.has('package.json')) {
        if (unstagedFiles.has('package.json')) {
            console.error('❌ Root package.json has uncommitted changes\n');
            hasCriticalIssues = true;
        }
        if (stagedFiles.has('package.json')) {
            console.error('❌ Root package.json is staged but not committed\n');
            hasCriticalIssues = true;
        }
    }

    // Check ALL workspaces for uncommitted changes, not just dirty ones
    for (const [wsName, issues] of workspaceIssues.entries()) {
        if (
            issues.unstagedFiles.length === 0 &&
            issues.stagedFiles.length === 0 &&
            issues.untrackedFiles.length === 0
        ) {
            continue;
        }

        const wsStatus = dirtyMap.get(wsName);
        let hasWorkspaceIssues = false;

        if (issues.unstagedFiles.length > 0 || issues.stagedFiles.length > 0) {
            hasWorkspaceIssues = true;
        }

        if (issues.untrackedFiles.length > 0) {
            const hasCriticalUntracked = issues.untrackedFiles.some((f) =>
                f.includes('package.json')
            );
            if (wsStatus === 'new' || hasCriticalUntracked) {
                hasWorkspaceIssues = true;
            }
        }

        if (hasWorkspaceIssues) {
            hasCriticalIssues = true;

            // Show appropriate header based on what issues exist
            if (
                issues.unstagedFiles.length > 0 &&
                issues.stagedFiles.length === 0
            ) {
                console.error(
                    `❌ Workspace '${wsName}' has uncommitted changes:`
                );
            } else if (
                issues.stagedFiles.length > 0 &&
                issues.unstagedFiles.length === 0
            ) {
                console.error(
                    `❌ Workspace '${wsName}' is staged but not committed:`
                );
            } else {
                console.error(
                    `❌ Workspace '${wsName}' has uncommitted changes:`
                );
            }

            if (issues.unstagedFiles.length > 0) {
                console.error('  • Uncommitted files:');
                for (const f of issues.unstagedFiles) {
                    console.error(`    - ${f}`);
                }
            }

            if (issues.stagedFiles.length > 0) {
                console.error('  • Staged files:');
                for (const f of issues.stagedFiles) {
                    console.error(`    - ${f}`);
                }
            }

            if (issues.untrackedFiles.length > 0) {
                const criticalUntracked = issues.untrackedFiles.filter(
                    (f) => wsStatus === 'new' || f.includes('package.json')
                );
                if (criticalUntracked.length > 0) {
                    console.error('  • Untracked files:');
                    for (const f of criticalUntracked) {
                        if (f.includes('package.json')) {
                            console.error(`    - ${f} (must be tracked)`);
                        } else {
                            console.error(`    - ${f}`);
                        }
                    }
                }
            }
            console.error('');
        }
    }

    if (hasCriticalIssues) {
        return false;
    }

    // Show warnings for non-critical untracked files
    for (const [wsName, issues] of workspaceIssues.entries()) {
        const wsStatus = dirtyMap.get(wsName);
        const nonCriticalUntracked = issues.untrackedFiles.filter(
            (f) => !f.includes('package.json') && wsStatus !== 'new'
        );

        if (nonCriticalUntracked.length > 0) {
            console.warn(`\n⚠️  Workspace '${wsName}' has untracked files:`);
            console.warn('  (Add to git or add to .gitignore)');
            for (const f of nonCriticalUntracked) {
                console.warn(`    - ${f}`);
            }
        }
    }

    if (hasCriticalIssues) {
        return false;
    }

    // Check for unpushed commits (with auto-tick exception)
    if (autoTick && dryRun) {
        const upstreamResult = git(['rev-parse', '--abbrev-ref', '@{u}'], {
            cwd,
        });
        if (upstreamResult.success) {
            const upstream = upstreamResult.stdout.trim();
            const unpushedRaw = git(
                ['log', `${upstream}..HEAD`, '--pretty=%B%n==END=='],
                { cwd }
            );
            if (unpushedRaw.success && unpushedRaw.stdout.trim()) {
                const msgs = unpushedRaw.stdout
                    .split('==END==')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const hasAutoTick = msgs.some(
                    (msg) =>
                        msg.split('\n')[0].trim() ===
                        'CHORE: Auto tick stale versions'
                );
                if (hasAutoTick) {
                    console.log(
                        'ℹ️ Previous dry-run auto-tick detected; allowing unpushed commits\n'
                    );
                    return true;
                }
            }
        }
    }

    return checkForUnpushedCommits(cwd);
}

/**
 * Get version info for dirty workspaces
 */
function getVersionChanges(
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
    const versionChanges = new Map();

    for (const ws of workspaces) {
        const status = dirtyMap.get(ws.name);
        if (status !== 'dirty' && status !== 'new') continue;

        const pkgPath = resolve(cwd, ws.path, 'package.json');
        const currentPkg = JSON.parse(
            readFileSync(pkgPath, 'utf8')
        ) as PackageJson;
        const newVersion = currentPkg.version as string;

        if (!semver.valid(newVersion)) {
            throw new Error(`Invalid version "${newVersion}" in ${ws.name}`);
        }

        if (status === 'new' || !lastTag) {
            versionChanges.set(ws.name, {
                oldVersion: null,
                newVersion,
                versionChanged: true,
                versionIncremented: true,
            });
            continue;
        }

        // Get old version from tag
        const relativeWsPath = relative(cwd, ws.path);
        const previousPkgRaw = git(
            ['show', `${lastTag}:${relativeWsPath}/package.json`],
            { cwd }
        );

        let oldVersion: string | null = null;
        if (previousPkgRaw.success) {
            try {
                const previousPkg = JSON.parse(
                    previousPkgRaw.stdout
                ) as PackageJson;
                oldVersion = previousPkg.version as string;
            } catch {
                oldVersion = null;
            }
        }

        const versionChanged = oldVersion === null || newVersion !== oldVersion;
        const versionIncremented =
            oldVersion !== null && semver.gt(newVersion, oldVersion);

        versionChanges.set(ws.name, {
            oldVersion,
            newVersion,
            versionChanged,
            versionIncremented,
        });
    }

    return versionChanges;
}

function validateRootVersion(
    lastTag: string | null,
    cwd: string,
    anyWorkspaceDirty: boolean
): {
    currentVersion: string;
    previousVersion?: string;
    needsTick: boolean;
    message: string;
} {
    const rootPkgPath = resolve(cwd, 'package.json');
    const rootPkg = JSON.parse(
        readFileSync(rootPkgPath, 'utf8')
    ) as PackageJson;
    const currentVersion = rootPkg.version as string;

    if (!semver.valid(currentVersion)) {
        throw new Error(`Invalid root version: ${currentVersion}`);
    }

    if (!lastTag) {
        return {
            currentVersion,
            needsTick: false,
            message: `🌳 Root: ${currentVersion} (first release)`,
        };
    }

    const lastRootPkgRaw = git(['show', `${lastTag}:package.json`], { cwd });
    if (!lastRootPkgRaw.success) {
        return {
            currentVersion,
            needsTick: false,
            message: `🌳 Root: ${currentVersion}`,
        };
    }

    const lastRootPkg = JSON.parse(lastRootPkgRaw.stdout) as PackageJson;
    const previousVersion = lastRootPkg.version as string;

    if (!anyWorkspaceDirty) {
        return {
            currentVersion,
            previousVersion,
            needsTick: false,
            message: `✔️ Root: ${currentVersion} (unchanged)`,
        };
    }

    if (semver.gt(currentVersion, previousVersion)) {
        return {
            currentVersion,
            previousVersion,
            needsTick: false,
            message: `🌳 Root: ${previousVersion} → ${currentVersion}`,
        };
    }

    return {
        currentVersion,
        previousVersion,
        needsTick: true,
        message: `❌ Root: ${previousVersion} → ${currentVersion} (needs bump)`,
    };
}

function readPackageJsonSync(path: string): PackageJson | null {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as PackageJson;
    } catch {
        return null;
    }
}

function bumpPatchVersion(pkgDir: string) {
    execSync(`npm version patch --no-git-tag-version --force`, {
        cwd: pkgDir,
        stdio: 'inherit',
        env: { ...process.env, FORCE_COLOR: '1' },
    });
}

function gitAddCommitPush(files: string[], cwdArg: string, dryRun: boolean) {
    if (files.length === 0) return;
    execSync(`git add ${files.map((f) => `"${f}"`).join(' ')}`, {
        cwd: cwdArg,
        stdio: 'inherit',
    });
    execSync(`git commit -m "CHORE: Auto tick stale versions"`, {
        cwd: cwdArg,
        stdio: 'inherit',
    });
    if (!dryRun) {
        execSync(`git push`, { cwd: cwdArg, stdio: 'inherit' });
    }
}

function buildPackages(releaseOrder: string[], packageInfos: PackageInfos) {
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
            console.error(`❌ Build failed for ${pkgName}`);
            process.exit(1);
        }
    }
}

function validatePublish(dryRun: boolean, autoTick: boolean) {
    // Push any previous auto-tick commits if in full mode
    if (!dryRun) {
        const upstreamResult = git(['rev-parse', '--abbrev-ref', '@{u}'], {
            cwd,
        });
        if (upstreamResult.success) {
            const upstream = upstreamResult.stdout.trim();
            const unpushedRaw = git(
                ['log', `${upstream}..HEAD`, '--pretty=%B%n==END=='],
                { cwd }
            );
            if (unpushedRaw.success && unpushedRaw.stdout.trim()) {
                const msgs = unpushedRaw.stdout
                    .split('==END==')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const hasAutoTick = msgs.some(
                    (msg) =>
                        msg.split('\n')[0].trim() ===
                        'CHORE: Auto tick stale versions'
                );
                if (hasAutoTick) {
                    console.log('⬆️ Pushing previous auto-tick commits...\n');
                    execSync('git push', { cwd, stdio: 'inherit' });
                }
            }
        }
    }

    const lastTag = getLastTag(cwd);
    const workspaces = getWorkspaces(cwd);
    const packageInfos = getPackageInfos(cwd);
    const { dependencies } = createDependencyMap(packageInfos);
    const inDegree = calculateWorkspaceInDegree(workspaces, dependencies);
    const releaseOrderAll = getReleaseOrderFromInDegree(inDegree, dependencies);

    const releaseOrder = releaseOrderAll.filter((pkgName) => {
        const ws = packageInfos[pkgName];
        const isRoot = workspaces.some(
            (w) => w.path === '.' && w.name === pkgName
        );
        if (!isRoot && ws?.private) {
            console.log(`⚠️ Skipping private workspace: ${pkgName}`);
            return false;
        }
        return true;
    });

    console.log('🏗️  Building packages...');
    buildPackages(releaseOrder, packageInfos);

    // Get dirty workspaces
    console.log('\n🗃️  Validating git status...\n');
    const dirtyMap = getDirtyMap(workspaces, lastTag, cwd);

    // Check git status
    const gitClean = checkGitStatus(
        workspaces,
        dirtyMap,
        cwd,
        dryRun,
        autoTick
    );
    if (!gitClean) {
        console.error(
            '❌ Git issues detected. Commit/stash changes before publishing.\n'
        );
        process.exit(1);
    }

    console.log('✅ Git status is clean\n');

    // Check versions
    console.log('#️⃣  Validating versions...\n');

    const versionChanges = getVersionChanges(
        workspaces,
        dirtyMap,
        lastTag,
        cwd
    );
    const anyWorkspaceDirty = Array.from(dirtyMap.values()).some(
        (s) => s !== 'unchanged'
    );
    const rootValidation = validateRootVersion(lastTag, cwd, anyWorkspaceDirty);

    let hasVersionIssues = false;
    const packagesNeedingTick: string[] = [];

    for (const [pkgName, info] of versionChanges.entries()) {
        if (!info.versionChanged) {
            const ws = workspaces.find((w) => w.name === pkgName);
            const pkgJsonPath = ws
                ? resolve(cwd, ws.path, 'package.json')
                : null;
            console.error(
                `❌ ${pkgName}: version unchanged at ${info.newVersion} (needs increment)`
            );
            if (pkgJsonPath) {
                console.error(`   Update version in: ${pkgJsonPath}`);
            }
            hasVersionIssues = true;
            packagesNeedingTick.push(pkgName);
        } else if (!info.versionIncremented && info.oldVersion) {
            const ws = workspaces.find((w) => w.name === pkgName);
            const pkgJsonPath = ws
                ? resolve(cwd, ws.path, 'package.json')
                : null;
            console.error(
                `❌ ${pkgName}: version must be greater than ${info.oldVersion} (currently ${info.newVersion})`
            );
            if (pkgJsonPath) {
                console.error(`   Update version in: ${pkgJsonPath}`);
            }
            hasVersionIssues = true;
            packagesNeedingTick.push(pkgName);
        }
    }

    if (rootValidation.needsTick) {
        const rootPkgJsonPath = resolve(cwd, 'package.json');
        console.error(
            `❌ Root: version unchanged at ${rootValidation.currentVersion} (needs increment)`
        );
        console.error(`   Update version in: ${rootPkgJsonPath}`);
        hasVersionIssues = true;
    }

    if (hasVersionIssues) {
        console.error('');
        if (!autoTick) {
            console.error(
                '❌ Use --auto-tick to fix automatically, or bump manually.\n'
            );
            process.exit(1);
        }

        // Auto-tick
        console.log('🔧 Auto-tick requested; bumping versions...\n');
        const filesToCommit: string[] = [];

        for (const pkgName of Array.from(new Set(packagesNeedingTick))) {
            const ws = workspaces.find((w) => w.name === pkgName);
            if (!ws) continue;
            const pkgDir = resolve(cwd, ws.path);
            console.log(`⬆️ Auto-ticking ${pkgName}`);
            bumpPatchVersion(pkgDir);
            filesToCommit.push(resolve(pkgDir, 'package.json'));
        }

        if (rootValidation.needsTick) {
            console.log('⬆️ Auto-ticking root package');
            bumpPatchVersion(cwd);
            filesToCommit.push(resolve(cwd, 'package.json'));
            const lockFile = resolve(cwd, 'package-lock.json');
            if (existsSync(lockFile)) filesToCommit.push(lockFile);
        }

        gitAddCommitPush(filesToCommit, cwd, dryRun);

        // Re-validate
        const newVersionChanges = getVersionChanges(
            workspaces,
            dirtyMap,
            lastTag,
            cwd
        );
        const newRootValidation = validateRootVersion(
            lastTag,
            cwd,
            anyWorkspaceDirty
        );

        versionChanges.clear();
        for (const [k, v] of newVersionChanges.entries()) {
            versionChanges.set(k, v);
        }

        Object.assign(rootValidation, newRootValidation);

        console.log('\n🗃️  Re-validating...\n');

        // In dry-run mode, we allow the auto-tick commit to remain unpushed
        if (!dryRun) {
            if (!checkForUnpushedCommits(cwd)) {
                process.exit(1);
            }
        } else {
            console.log(
                'ℹ️ Dry-run mode: auto-tick commit created but not pushed\n'
            );
        }
    }

    // Print publish summary
    console.log('📝 Publish summary:\n');
    console.log(rootValidation.message);
    console.log('');

    const packagesToRelease: string[] = [];

    for (const pkgName of releaseOrder) {
        const status = dirtyMap.get(pkgName);
        const versionInfo = versionChanges.get(pkgName);

        if (status === 'new') {
            packagesToRelease.push(pkgName);
            console.log(`🆕 ${pkgName} @ ${versionInfo?.newVersion} (new)`);
        } else if (status === 'dirty') {
            packagesToRelease.push(pkgName);
            if (versionInfo) {
                console.log(
                    `⬆️ ${pkgName}: ${versionInfo.oldVersion} → ${versionInfo.newVersion}`
                );
            }
        } else {
            const ws = workspaces.find((w) => w.name === pkgName);
            if (ws) {
                const version = readPackageJsonSync(
                    resolve(cwd, ws.path, 'package.json')
                )?.version;
                console.log(`✔️ ${pkgName} @ ${version} (unchanged)`);
            }
        }
    }

    return {
        releaseOrder,
        packageInfos,
        packagesToRelease,
        currentRootVersion: rootValidation.currentVersion,
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

        originals.set(pkgName, JSON.stringify(packageJson, null, 4));

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
                        `🆙 ${pkgName}: ${depType}.${depName} → ${newVersion}`
                    );
                }
            }
        }

        if (changed) {
            writeFileSync(
                packageJsonPath,
                JSON.stringify(packageJson, null, 4) + '\n'
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
            writeFileSync(
                pkgInfo.packageJsonPath,
                original.endsWith('\n') ? original : original + '\n'
            );
            console.log(`♻️ Restored ${pkgName}`);
        }
    }
}

function runNpmPublishInReleaseOrder(
    releaseOrder: string[],
    packageInfos: PackageInfos,
    packagesToRelease: string[],
    registryUrl?: string
) {
    let registryFlag = '';
    if (registryUrl) {
        registryFlag = ` --registry=${registryUrl}`;
    } else {
        const homeNpmrc = `${homedir()}/.npmrc`;
        if (existsSync(homeNpmrc)) {
            const lines = readFileSync(homeNpmrc, 'utf8').split(/\r?\n/);
            const line = lines.find((l) => l.trim().startsWith('registry='));
            if (line) {
                registryFlag = ` --registry=${line.split('=')[1].trim()}`;
            }
        }
    }

    for (const packageName of releaseOrder) {
        if (!packagesToRelease.includes(packageName)) continue;

        const pkgInfo = packageInfos[packageName];
        const pkgDir = dirname(pkgInfo.packageJsonPath);
        console.log(`\n📦 Publishing ${packageName}...`);

        try {
            execSync(`npm publish${registryFlag}`, {
                cwd: pkgDir,
                stdio: 'inherit',
                env: { ...process.env, FORCE_COLOR: '1' },
            });
            console.log(`✅ ${packageName} published`);
        } catch (error) {
            console.error(`❌ Failed to publish ${packageName}`);
            throw error;
        }
    }
}

function tagAndPushRepo(version: string) {
    try {
        execSync(`git tag v${version}`, { stdio: 'inherit' });
        execSync(`git push origin v${version}`, { stdio: 'inherit' });
        console.log(`✅ Tagged v${version}`);
    } catch (err) {
        console.error(`❌ Failed to tag v${version}`);
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
    .option('--auto-tick', 'Automatically tick patch versions if needed')
    .action((options) => {
        printHeader();

        const dryRun = options.dryRun;
        const registryUrl = options.registry;
        const autoTick = options.autoTick;

        const {
            packageInfos,
            releaseOrder,
            packagesToRelease,
            currentRootVersion,
        } = validatePublish(dryRun, autoTick);

        if (packagesToRelease.length === 0) {
            return console.log('\n￣\\_(ツ)_/￣ No workspaces to publish\n');
        }

        let originalPackageJsons: Map<string, string> | null = null;

        try {
            if (!dryRun) {
                console.log('\n🆙 Updating workspace dependencies...');
                originalPackageJsons = replaceWorkspaceDepsWithVersions(
                    packageInfos,
                    packagesToRelease
                );
            } else {
                console.log(
                    '\n[dry-run] 🆙 Would update workspace dependencies'
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
                console.log('\n🎉 All packages published!\n');
                console.log(
                    `🏷️ Tagging repository with v${currentRootVersion}...`
                );
                tagAndPushRepo(currentRootVersion);
            } else {
                console.log('\n[dry-run] 📦 Would publish:');
                packagesToRelease.forEach((pkg) => console.log(`  - ${pkg}`));
                console.log(`\n[dry-run] 🏷️ Would tag: v${currentRootVersion}`);
            }
        } catch (error) {
            console.error('\n❌ Publishing failed:', error);
            process.exit(1);
        } finally {
            if (!dryRun && originalPackageJsons) {
                console.log('\n♻️ Restoring workspace dependencies...');
                restoreWorkspaceDepsToStar(
                    packageInfos,
                    packagesToRelease,
                    originalPackageJsons
                );
                console.log('♻️ Restoration complete.\n');
            } else if (dryRun) {
                console.log(
                    '\n[dry-run] ♻️ Would restore workspace dependencies\n'
                );
            }
        }
    });

program.parse(process.argv);
