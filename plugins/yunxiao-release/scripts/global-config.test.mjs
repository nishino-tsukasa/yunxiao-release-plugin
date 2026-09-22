#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeRemoteUrl, readGlobalProjectConfig, resolveGlobalDefaultsPath, resolveGlobalRepositoriesPath } from './global-config.mjs';
import { applyGlobalConfig, finalizeProjectMigration, initializeGlobalConfig } from './configure-global.mjs';
import { readProjectConfig } from './release-state.mjs';

const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-config-'));
const configHome = resolve(root, 'config');
const env = { HOME: root, XDG_CONFIG_HOME: configHome };
execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
execFileSync('git', ['remote', 'add', 'origin', 'git@codeup.aliyun.com:example/service.git'], { cwd: root });
mkdirSync(resolve(configHome, 'yunxiao-release'), { recursive: true });
const emptyRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-empty-'));
const emptyEnv = { HOME: emptyRoot, XDG_CONFIG_HOME: resolve(emptyRoot, 'config') };
initializeGlobalConfig(emptyEnv);
assert.deepEqual(applyGlobalConfig({
  defaults: { organizationId: 'org-2' },
  repositories: { 'codeup.aliyun.com/group/repo': { repositoryId: '2' } },
}, emptyEnv), { defaultFieldCount: 1, repositoryCount: 1, projectConfigAction: 'not-requested' });
assert.equal(JSON.parse(readFileSync(resolveGlobalDefaultsPath(emptyEnv))).organizationId, 'org-2');
assert.equal(JSON.parse(readFileSync(resolveGlobalRepositoriesPath(emptyEnv))).repositories['codeup.aliyun.com/group/repo'].repositoryId, '2');
assert.throws(() => applyGlobalConfig({ defaults: { repositoryId: 'bad' } }, emptyEnv), /不能包含 repositoryId/);
assert.doesNotThrow(() => applyGlobalConfig({ repositories: {
  'codeup.aliyun.com/group/service': { projectType: 'custom', targetBranch: 'custom-target' },
} }, emptyEnv));
const inheritedRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-inherited-'));
const inheritedEnv = { HOME: inheritedRoot, XDG_CONFIG_HOME: resolve(inheritedRoot, 'config') };
assert.doesNotThrow(() => applyGlobalConfig({
  defaults: { targetBranch: 'release' },
  repositories: { 'codeup.aliyun.com/group/backend': { projectType: 'backend', repositoryId: '3' } },
}, inheritedEnv));

const legacyRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-legacy-'));
const legacyEnv = { HOME: legacyRoot, XDG_CONFIG_HOME: resolve(legacyRoot, 'config') };
mkdirSync(resolve(legacyEnv.XDG_CONFIG_HOME, 'yunxiao-release'), { recursive: true });
writeFileSync(resolve(legacyEnv.XDG_CONFIG_HOME, 'yunxiao-release/projects.json'), `${JSON.stringify({
  defaults: { organizationId: 'legacy-org' },
  repositories: { 'codeup.aliyun.com/group/legacy': { repositoryId: 'legacy-repo' } },
})}\n`);
initializeGlobalConfig(legacyEnv);
assert.equal(JSON.parse(readFileSync(resolveGlobalDefaultsPath(legacyEnv))).organizationId, 'legacy-org');
assert.equal(JSON.parse(readFileSync(resolveGlobalRepositoriesPath(legacyEnv))).repositories['codeup.aliyun.com/group/legacy'].repositoryId, 'legacy-repo');
writeFileSync(resolveGlobalDefaultsPath(env), `${JSON.stringify({
  schemaVersion: 1, organizationId: 'org-1', targetBranch: 'master', reviewerMode: 'ask',
})}\n`);
writeFileSync(resolveGlobalRepositoriesPath(env), `${JSON.stringify({
  schemaVersion: 1, repositories: {
    'codeup.aliyun.com/example/service': {
      projectType: 'backend',
      projectConfigMigration: 'retain',
      repositoryId: 'repo-1',
      remoteName: 'origin',
      targetBranch: 'release',
      reviewerMode: 'fixed',
      reviewerUserIds: ['reviewer-1'],
      versionFile: null,
      announcementFile: null,
      localConfigFile: '.agents/yunxiao-release.local.json',
      runtimeFile: '.agents/runtime/yunxiao-release-mr.json',
      commentsFile: '.agents/runtime/yunxiao-release-comments.md',
      validationCommands: ['git diff --check'],
      testDeployments: [{ environment: 'fat', targetBranch: 'fat/fat', hookUrl: 'https://example.com/hook' }],
    },
  },
})}\n`);

assert.equal(normalizeRemoteUrl('https://codeup.aliyun.com/example/service.git'), 'codeup.aliyun.com/example/service');
assert.equal(readGlobalProjectConfig(root, env).repositoryKey, 'codeup.aliyun.com/example/service');
assert.equal(readProjectConfig(root, env).repositoryId, 'repo-1');
assert.equal(readProjectConfig(root, env).targetBranch, 'release');
assert.equal(readProjectConfig(root, env).versionFile, null);
assert.equal(readProjectConfig(root, env).testDeployments[0].targetBranch, 'fat/fat');
mkdirSync(resolve(root, '.agents'));
writeFileSync(resolve(root, '.agents/yunxiao-release.json'), '{"organizationId":"org-1","repositoryId":"repo-1","targetBranch":"release"}\n');
assert.equal(readProjectConfig(root, env).targetBranch, 'release');
assert.equal(readProjectConfig(root, env).repositoryId, 'repo-1');
writeFileSync(resolve(root, '.agents/yunxiao-release.json'), '{"organizationId":"org-1","repositoryId":"repo-1","targetBranch":"master"}\n');
assert.equal(readProjectConfig(root, env).targetBranch, 'master');
writeFileSync(resolve(root, '.agents/yunxiao-release.json'), '{"organizationId":"org-1","repositoryId":"repo-1","targetBranch":"release"}\n');
assert.equal(finalizeProjectMigration({ rootDir: root }, env), 'retained');
assert.equal(existsSync(resolve(root, '.agents/yunxiao-release.json')), true);
const repositoryDocument = JSON.parse(readFileSync(resolveGlobalRepositoriesPath(env)));
repositoryDocument.repositories['codeup.aliyun.com/example/service'].projectConfigMigration = 'delete';
writeFileSync(resolveGlobalRepositoriesPath(env), `${JSON.stringify(repositoryDocument)}\n`);
assert.equal(finalizeProjectMigration({ rootDir: root }, env), 'deleted');
assert.equal(existsSync(resolve(root, '.agents/yunxiao-release.json')), false);

writeFileSync(resolveGlobalDefaultsPath(env), '{"schemaVersion":1,"repositoryId":"bad"}\n');
assert.throws(() => readProjectConfig(root, env), /不能包含 repositoryId/);
rmSync(root, { recursive: true, force: true });
rmSync(emptyRoot, { recursive: true, force: true });
rmSync(legacyRoot, { recursive: true, force: true });
rmSync(inheritedRoot, { recursive: true, force: true });
console.log('global-config self-test passed');
