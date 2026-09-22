#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeRemoteUrl, readGlobalProjectConfig, resolveGlobalDefaultsPath, resolveGlobalRepositoriesPath } from './global-config.mjs';
import { applyGlobalConfig, initializeGlobalConfig } from './configure-global.mjs';
import { readProjectConfig } from './release-state.mjs';

const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-config-'));
const configHome = resolve(root, 'config');
const env = { HOME: root, XDG_CONFIG_HOME: configHome };
execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
execFileSync('git', ['remote', 'add', 'origin', 'git@codeup.aliyun.com:supermonkey/monkey-core.git'], { cwd: root });
mkdirSync(resolve(configHome, 'yunxiao-release'), { recursive: true });
const emptyRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-empty-'));
const emptyEnv = { HOME: emptyRoot, XDG_CONFIG_HOME: resolve(emptyRoot, 'config') };
initializeGlobalConfig(emptyEnv);
assert.deepEqual(applyGlobalConfig({
  defaults: { organizationId: 'org-2' },
  repositories: { 'codeup.aliyun.com/group/repo': { repositoryId: '2' } },
}, emptyEnv), { defaultFieldCount: 1, repositoryCount: 1 });
assert.equal(JSON.parse(readFileSync(resolveGlobalDefaultsPath(emptyEnv))).organizationId, 'org-2');
assert.equal(JSON.parse(readFileSync(resolveGlobalRepositoriesPath(emptyEnv))).repositories['codeup.aliyun.com/group/repo'].repositoryId, '2');
assert.throws(() => applyGlobalConfig({ defaults: { repositoryId: 'bad' } }, emptyEnv), /不能包含 repositoryId/);
writeFileSync(resolveGlobalDefaultsPath(env), `${JSON.stringify({
  schemaVersion: 1, organizationId: 'org-1', targetBranch: 'master', reviewerMode: 'ask',
})}\n`);
writeFileSync(resolveGlobalRepositoriesPath(env), `${JSON.stringify({
  schemaVersion: 1, repositories: {
    'codeup.aliyun.com/supermonkey/monkey-core': { repositoryId: 'repo-1', targetBranch: 'fat/fat' },
  },
})}\n`);

assert.equal(normalizeRemoteUrl('https://codeup.aliyun.com/supermonkey/monkey-core.git'), 'codeup.aliyun.com/supermonkey/monkey-core');
assert.equal(readGlobalProjectConfig(root, env).repositoryKey, 'codeup.aliyun.com/supermonkey/monkey-core');
assert.equal(readProjectConfig(root, env).repositoryId, 'repo-1');
assert.equal(readProjectConfig(root, env).targetBranch, 'fat/fat');
mkdirSync(resolve(root, '.agents'));
writeFileSync(resolve(root, '.agents/yunxiao-release.json'), '{"organizationId":"","repositoryId":"","targetBranch":"release"}\n');
assert.equal(readProjectConfig(root, env).targetBranch, 'release');
assert.equal(readProjectConfig(root, env).repositoryId, 'repo-1');

writeFileSync(resolveGlobalDefaultsPath(env), '{"schemaVersion":1,"repositoryId":"bad"}\n');
assert.throws(() => readProjectConfig(root, env), /不能包含 repositoryId/);
rmSync(root, { recursive: true, force: true });
rmSync(emptyRoot, { recursive: true, force: true });
console.log('global-config self-test passed');
