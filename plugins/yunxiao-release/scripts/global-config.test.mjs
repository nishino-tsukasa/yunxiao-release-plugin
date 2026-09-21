#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeRemoteUrl, readGlobalProjectConfig, resolveGlobalConfigPath } from './global-config.mjs';
import { readProjectConfig } from './release-state.mjs';

const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-global-config-'));
const configHome = resolve(root, 'config');
const env = { HOME: root, XDG_CONFIG_HOME: configHome };
execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
execFileSync('git', ['remote', 'add', 'origin', 'git@codeup.aliyun.com:supermonkey/monkey-core.git'], { cwd: root });
mkdirSync(resolve(configHome, 'yunxiao-release'), { recursive: true });
writeFileSync(resolveGlobalConfigPath(env), `${JSON.stringify({
  schemaVersion: 1,
  defaults: { organizationId: 'org-1', targetBranch: 'master', reviewerMode: 'ask' },
  repositories: {
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

writeFileSync(resolveGlobalConfigPath(env), '{"schemaVersion":1,"defaults":{"repositoryId":"bad"}}\n');
assert.throws(() => readProjectConfig(root, env), /不能配置 repositoryId/);
rmSync(root, { recursive: true, force: true });
console.log('global-config self-test passed');
