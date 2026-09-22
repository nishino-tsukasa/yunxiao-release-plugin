#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { checkConfig, getCurrentMr, readProjectConfig, upsertMr } from './release-state.mjs';

const writeJson = (filePath, value) => {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

// 覆盖配置校验、同 MR 幂等更新和同分支选择最新 MR 三条状态主路径。
const run = () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-state-'));
  const codexDir = resolve(rootDir, '.codex');
  const agentsDir = resolve(rootDir, '.agents');
  mkdirSync(codexDir, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const baseConfig = {
    organizationId: 'org-1', repositoryId: 'repo-1', remoteName: 'upstream', targetBranch: 'stable',
    reviewerMode: 'ask', reviewerUserIds: [], versionFile: null, announcementFile: null,
    localConfigFile: '.agents/yunxiao-release.local.json', runtimeFile: '.agents/runtime/yunxiao-release-mr.json',
    commentsFile: '.agents/runtime/yunxiao-release-comments.md', validationCommands: ['git diff --check'], testDeployments: [],
  };
  writeJson(resolve(agentsDir, 'yunxiao-release.json'), {
    ...baseConfig,
  });
  writeJson(resolve(agentsDir, 'yunxiao-release.local.json'), {
    displayName: '@测试成员',
    userId: 'user-1',
  });
  const baseRecord = {
    mrId: '10',
    title: '初始标题',
    url: 'https://codeup.aliyun.com/example/change/10',
    createdAt: '2026-07-16T01:00:00.000Z',
    createdBy: 'user-1',
    sourceBranch: 'feature/example',
    targetBranch: 'stable',
    reviewMode: 'skip',
    lastSyncedAt: '2026-07-16T01:01:00.000Z',
  };
  assert.equal(checkConfig(rootDir).config.targetBranch, 'stable');
  assert.equal(checkConfig(rootDir).config.versionFile, null);
  assert.deepEqual(checkConfig(rootDir).config.testDeployments, []);
  assert.equal(checkConfig(rootDir).localConfig.userId, 'user-1');
  assert.equal(checkConfig(rootDir).memberConfigSource, 'project');
  const xdgConfigHome = resolve(rootDir, 'xdg-config');
  mkdirSync(resolve(xdgConfigHome, 'yunxiao-release'), { recursive: true });
  writeJson(resolve(xdgConfigHome, 'yunxiao-release/member.json'), {
    displayName: '用户级成员',
    userId: 'user-member',
  });
  rmSync(resolve(agentsDir, 'yunxiao-release.local.json'));
  const homeConfig = checkConfig(rootDir, { HOME: rootDir, XDG_CONFIG_HOME: xdgConfigHome });
  assert.deepEqual(homeConfig.localConfig, { displayName: '用户级成员', userId: 'user-member' });
  assert.equal(homeConfig.memberConfigSource, 'user');
  rmSync(resolve(xdgConfigHome, 'yunxiao-release/member.json'));
  const codexHome = resolve(rootDir, 'codex-home');
  mkdirSync(codexHome);
  writeFileSync(resolve(codexHome, '.env'), 'YUNXIAO_DISPLAY_NAME="旧成员"\nYUNXIAO_USER_ID="legacy-user"\n');
  const legacyConfig = checkConfig(rootDir, { CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome });
  assert.deepEqual(legacyConfig.localConfig, { displayName: '旧成员', userId: 'legacy-user' });
  assert.equal(legacyConfig.memberConfigSource, 'legacy-codex-home');
  const emptyCodexHome = resolve(rootDir, 'empty-codex-home');
  mkdirSync(emptyCodexHome);
  writeFileSync(resolve(emptyCodexHome, '.env'), 'YUNXIAO_DISPLAY_NAME="不完整"\n');
  assert.throws(
    () => checkConfig(rootDir, { CODEX_HOME: emptyCodexHome, XDG_CONFIG_HOME: xdgConfigHome }),
    /Codex Home 成员配置不完整/,
  );
  writeJson(resolve(agentsDir, 'yunxiao-release.local.json'), {
    displayName: '@测试成员',
    userId: 'user-1',
    tokenSource: 'legacy-value',
  });
  assert.equal(checkConfig(rootDir, { CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome }).memberConfigSource, 'project');
  assert.equal(checkConfig(rootDir, { CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome }).localConfig.userId, 'user-1');
  writeJson(resolve(agentsDir, 'yunxiao-release.json'), {
    ...baseConfig,
    testDeployments: [
      { environment: 'fat', targetBranch: 'develop', hookUrl: 'https://example.com/hook' },
      { environment: 'production', webUrl: 'https://example.com/pipeline' },
    ],
  });
  assert.equal(readProjectConfig(rootDir).testDeployments[0].targetBranch, 'develop');
  assert.equal(readProjectConfig(rootDir).testDeployments[1].webUrl, 'https://example.com/pipeline');
  writeJson(resolve(agentsDir, 'yunxiao-release.json'), {
    ...baseConfig,
    testDeployments: [{ environment: 'broken', targetBranch: 'develop' }],
  });
  assert.throws(() => readProjectConfig(rootDir), /targetBranch 和 hookUrl 必须同时配置/);
  writeJson(resolve(agentsDir, 'yunxiao-release.json'), {
    ...baseConfig,
    reviewMode: 'ask',
  });
  assert.equal(Object.hasOwn(readProjectConfig(rootDir), 'reviewMode'), false);
  upsertMr(rootDir, baseRecord);
  upsertMr(rootDir, { ...baseRecord, title: '更新标题' });
  assert.equal(Object.hasOwn(getCurrentMr(rootDir, 'feature/example'), 'reviewMode'), false);
  upsertMr(rootDir, {
    ...baseRecord,
    mrId: '11',
    title: '最新 MR',
    url: 'https://codeup.aliyun.com/example/change/11',
    createdAt: '2026-07-16T02:00:00.000Z',
  });
  assert.equal(getCurrentMr(rootDir, 'feature/example').mrId, '11');
  writeJson(resolve(agentsDir, 'yunxiao-release.json'), {
    ...baseConfig,
    runtimeFile: '../outside.json',
  });
  assert.throws(() => getCurrentMr(rootDir, 'feature/example'), /项目内相对路径|项目目录内/);
  rmSync(rootDir, { recursive: true, force: true });
  console.log('release-state self-test passed');
};

run();
