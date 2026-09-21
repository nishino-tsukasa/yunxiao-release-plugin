#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { buildConfig, configureProject, writeProjectConfig } from './configure-project.mjs';
import {
  readMemberFromEnvContent,
  readUserMember,
  resolveUserMemberPath,
  writeUserMember,
} from './configure-member.mjs';
import { hasConfiguredToken, migrateLegacyToken, resolveCodexEnvPath, resolveCredentialPath, syncCodexToken, upsertToken, writeToken } from './configure-token.mjs';

// 覆盖模板生成、已有配置保留、路径边界和 Token 安全写入主路径。
const run = () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-config-'));
  const config = buildConfig();
  assert.equal(config.organizationId, '');
  assert.equal(config.repositoryId, '');
  assert.equal(config.targetBranch, 'master');
  assert.equal(config.remoteName, 'origin');
  assert.equal(Object.hasOwn(config, 'reviewMode'), false);
  assert.equal(config.reviewerMode, 'ask');
  assert.deepEqual(config.reviewerUserIds, []);
  assert.deepEqual(config.testDeployments, []);
  assert.equal(config.versionFile, 'package.json');
  assert.equal(buildConfig({ versionFile: null }).versionFile, null);
  assert.equal(Object.hasOwn(buildConfig({ reviewMode: 'skip' }), 'reviewMode'), false);
  assert.equal(buildConfig({ targetBranch: 'main', versionFile: 'VERSION' }).targetBranch, 'main');
  assert.throws(() => writeProjectConfig(rootDir, config), /不是 Git 仓库/);
  execFileSync('git', ['init'], { cwd: rootDir, stdio: 'ignore' });
  writeFileSync(resolve(rootDir, '.gitignore'), '.codex/\n');
  assert.throws(() => writeProjectConfig(rootDir, { ...config, runtimeFile: '../outside.json' }), /项目内相对路径/);
  configureProject(rootDir);
  assert.equal(JSON.parse(readFileSync(resolve(rootDir, '.agents/yunxiao-release.json'))).targetBranch, 'master');
  assert.equal(spawnSync('git', ['check-ignore', '.agents/yunxiao-release.json'], { cwd: rootDir }).status, 1);
  assert.equal(
    readFileSync(resolve(rootDir, '.gitignore'), 'utf8'),
    '.codex/\n/.agents/yunxiao-release.local.json\n/.agents/runtime/\n',
  );

  const simpleRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-simple-ignore-'));
  execFileSync('git', ['init'], { cwd: simpleRoot, stdio: 'ignore' });
  configureProject(simpleRoot);
  assert.equal(
    readFileSync(resolve(simpleRoot, '.gitignore'), 'utf8'),
    '/.agents/yunxiao-release.local.json\n/.agents/runtime/\n',
  );
  assert.equal(spawnSync('git', ['check-ignore', '.agents/yunxiao-release.json'], { cwd: simpleRoot }).status, 1);
  assert.equal(spawnSync('git', ['check-ignore', '.agents/yunxiao-release.local.json'], { cwd: simpleRoot }).status, 0);
  assert.equal(spawnSync('git', ['check-ignore', '.agents/runtime/state.json'], { cwd: simpleRoot }).status, 0);
  assert.equal(spawnSync('git', ['check-ignore', '.codex/other.json'], { cwd: simpleRoot }).status, 1);
  assert.equal(existsSync(resolve(simpleRoot, '.codex')), false);
  writeFileSync(
    resolve(simpleRoot, '.gitignore'),
    '/.agents/yunxiao-release.local.json\n/.agents/runtime/\n/.agents/yunxiao-release.local.json\n/.agents/runtime/\n',
  );
  configureProject(simpleRoot);
  assert.equal(
    readFileSync(resolve(simpleRoot, '.gitignore'), 'utf8'),
    '/.agents/yunxiao-release.local.json\n/.agents/runtime/\n',
  );

  const ignoredAgentsRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-agents-ignore-'));
  execFileSync('git', ['init'], { cwd: ignoredAgentsRoot, stdio: 'ignore' });
  writeFileSync(resolve(ignoredAgentsRoot, '.gitignore'), '/.agents/\n');
  configureProject(ignoredAgentsRoot);
  assert.equal(spawnSync('git', ['check-ignore', '.agents/yunxiao-release.json'], { cwd: ignoredAgentsRoot }).status, 1);
  assert.equal(spawnSync('git', ['check-ignore', '.agents/yunxiao-release.local.json'], { cwd: ignoredAgentsRoot }).status, 0);
  assert.equal(spawnSync('git', ['check-ignore', '.agents/runtime/state.json'], { cwd: ignoredAgentsRoot }).status, 0);

  const legacyRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-legacy-ignore-'));
  execFileSync('git', ['init'], { cwd: legacyRoot, stdio: 'ignore' });
  writeFileSync(
    resolve(legacyRoot, '.gitignore'),
    '.codex/\n!/.codex/\n/.codex/*\n!/.codex/yunxiao-release.json\n/.codex/yunxiao-release.local.json\n/.codex/runtime/yunxiao-release-mr.json\n/.codex/runtime/yunxiao-release-comments.md\n',
  );
  mkdirSync(resolve(legacyRoot, '.codex'));
  writeFileSync(
    resolve(legacyRoot, '.codex/yunxiao-release.json'),
    `${JSON.stringify({
      ...config,
      organizationId: 'org',
      repositoryId: 'repo',
      localConfigFile: '.codex/yunxiao-release.local.json',
      runtimeFile: '.codex/runtime/yunxiao-release-mr.json',
      commentsFile: '.codex/runtime/yunxiao-release-comments.md',
    })}\n`,
  );
  writeFileSync(resolve(legacyRoot, '.codex/yunxiao-release.local.json'), '{"userId":"legacy-user"}\n');
  mkdirSync(resolve(legacyRoot, '.codex/runtime'));
  writeFileSync(resolve(legacyRoot, '.codex/runtime/yunxiao-release-mr.json'), '{"branches":{}}\n');
  configureProject(legacyRoot);
  const migratedConfig = JSON.parse(readFileSync(resolve(legacyRoot, '.agents/yunxiao-release.json')));
  assert.equal(existsSync(resolve(legacyRoot, '.codex/yunxiao-release.json')), false);
  assert.equal(migratedConfig.localConfigFile, '.agents/yunxiao-release.local.json');
  assert.equal(migratedConfig.runtimeFile, '.agents/runtime/yunxiao-release-mr.json');
  assert.equal(migratedConfig.commentsFile, '.agents/runtime/yunxiao-release-comments.md');
  assert.equal(existsSync(resolve(legacyRoot, '.codex/yunxiao-release.local.json')), false);
  assert.equal(readFileSync(resolve(legacyRoot, '.agents/yunxiao-release.local.json'), 'utf8'), '{"userId":"legacy-user"}\n');
  assert.equal(existsSync(resolve(legacyRoot, '.codex/runtime/yunxiao-release-mr.json')), false);
  assert.equal(readFileSync(resolve(legacyRoot, '.agents/runtime/yunxiao-release-mr.json'), 'utf8'), '{"branches":{}}\n');
  assert.equal(
    readFileSync(resolve(legacyRoot, '.gitignore'), 'utf8'),
    '.codex/\n!/.codex/\n/.codex/*\n!/.codex/yunxiao-release.json\n/.codex/yunxiao-release.local.json\n/.codex/runtime/yunxiao-release-mr.json\n/.codex/runtime/yunxiao-release-comments.md\n/.agents/yunxiao-release.local.json\n/.agents/runtime/\n',
  );

  const conflictRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-conflict-'));
  execFileSync('git', ['init'], { cwd: conflictRoot, stdio: 'ignore' });
  mkdirSync(resolve(conflictRoot, '.codex'));
  mkdirSync(resolve(conflictRoot, '.agents'));
  const conflictConfig = {
    ...config,
    organizationId: 'org',
    repositoryId: 'repo',
    localConfigFile: '.codex/yunxiao-release.local.json',
  };
  writeFileSync(resolve(conflictRoot, '.codex/yunxiao-release.json'), `${JSON.stringify(conflictConfig)}\n`);
  writeFileSync(resolve(conflictRoot, '.codex/yunxiao-release.local.json'), '{"userId":"old"}\n');
  writeFileSync(resolve(conflictRoot, '.agents/yunxiao-release.local.json'), '{"userId":"new"}\n');
  assert.throws(() => configureProject(conflictRoot), /新旧默认文件同时存在/);
  assert.equal(JSON.parse(readFileSync(resolve(conflictRoot, '.codex/yunxiao-release.json'))).localConfigFile, '.codex/yunxiao-release.local.json');
  assert.equal(existsSync(resolve(conflictRoot, '.agents/yunxiao-release.json')), false);
  assert.equal(readFileSync(resolve(conflictRoot, '.codex/yunxiao-release.local.json'), 'utf8'), '{"userId":"old"}\n');
  assert.equal(readFileSync(resolve(conflictRoot, '.agents/yunxiao-release.local.json'), 'utf8'), '{"userId":"new"}\n');
  writeFileSync(resolve(conflictRoot, '.agents/yunxiao-release.json'), `${JSON.stringify(config)}\n`);
  assert.throws(() => configureProject(conflictRoot), /新旧项目共享配置同时存在/);
  writeFileSync(
    resolve(rootDir, '.agents/yunxiao-release.json'),
    `${JSON.stringify({
      ...config,
      organizationId: 'org',
      repositoryId: 'repo',
      targetBranch: 'release',
      localConfigFile: '.private/member.json',
      runtimeFile: '.runtime/mr.json',
      commentsFile: '.runtime/comments.md',
    })}\n`,
  );
  configureProject(rootDir);
  assert.equal(JSON.parse(readFileSync(resolve(rootDir, '.agents/yunxiao-release.json'))).targetBranch, 'release');
  ['.private/member.json', '.runtime/mr.json', '.runtime/comments.md'].forEach((file) => {
    assert.equal(spawnSync('git', ['check-ignore', file], { cwd: rootDir }).status, 0);
  });

  const symlinkRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-symlink-'));
  const outsideRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-outside-'));
  execFileSync('git', ['init'], { cwd: symlinkRoot, stdio: 'ignore' });
  symlinkSync(outsideRoot, resolve(symlinkRoot, '.agents'), 'dir');
  assert.throws(() => configureProject(symlinkRoot), /现有父路径必须位于项目目录内/);

  const envPath = resolve(rootDir, 'codex-home/.env');
  mkdirSync(resolve(rootDir, 'codex-home'), { recursive: true });
  writeFileSync(envPath, 'OTHER=value\nYUNXIAO_ACCESS_TOKEN=old\n');
  writeToken(envPath, 'new-token');
  assert.equal(readFileSync(envPath, 'utf8'), 'OTHER=value\nYUNXIAO_ACCESS_TOKEN=new-token\n');
  assert.equal(statSync(envPath).mode & 0o777, 0o600);
  assert.equal(resolveCodexEnvPath({ CODEX_HOME: resolve(rootDir, 'codex-home') }), envPath);
  const tokenEnv = { HOME: rootDir, CODEX_HOME: resolve(rootDir, 'codex-home'), XDG_CONFIG_HOME: resolve(rootDir, 'xdg-config') };
  assert.equal(resolveCredentialPath(tokenEnv), resolve(rootDir, 'xdg-config/yunxiao-release/credentials.env'));
  assert.equal(migrateLegacyToken(tokenEnv), resolveCredentialPath(tokenEnv));
  assert.equal(hasConfiguredToken(readFileSync(resolveCredentialPath(tokenEnv), 'utf8')), true);
  assert.equal(syncCodexToken(tokenEnv), true);
  assert.match(upsertToken('', 'token'), /^YUNXIAO_ACCESS_TOKEN=token$/m);
  assert.equal(hasConfiguredToken('YUNXIAO_ACCESS_TOKEN=\n'), false);
  assert.equal(hasConfiguredToken('YUNXIAO_ACCESS_TOKEN=token\n'), true);
  assert.throws(() => upsertToken('', 'bad\ntoken'), /包含换行符/);
  const member = { displayName: '张三', userId: 'user-1' };
  const userEnv = { HOME: rootDir, XDG_CONFIG_HOME: resolve(rootDir, 'xdg-config') };
  const memberPath = resolve(rootDir, 'xdg-config/yunxiao-release/member.json');
  assert.equal(resolveUserMemberPath(userEnv), memberPath);
  assert.equal(resolveUserMemberPath({ HOME: rootDir, XDG_CONFIG_HOME: 'relative-config' }), resolve(rootDir, '.config/yunxiao-release/member.json'));
  writeUserMember(memberPath, member);
  assert.deepEqual(JSON.parse(readFileSync(memberPath, 'utf8')), member);
  assert.deepEqual(readUserMember(userEnv), member);
  assert.equal(statSync(resolve(rootDir, 'xdg-config/yunxiao-release')).mode & 0o777, 0o700);
  assert.equal(statSync(memberPath).mode & 0o777, 0o600);
  writeUserMember(memberPath, { ...member, feishuId: 'feishu-global' });
  writeUserMember(memberPath, { ...member, displayName: '更新成员' });
  assert.equal(JSON.parse(readFileSync(memberPath, 'utf8')).feishuId, 'feishu-global');
  const updatedMember = { displayName: '李四', userId: 'user-2' };
  writeUserMember(memberPath, updatedMember);
  assert.deepEqual(JSON.parse(readFileSync(memberPath, 'utf8')), { ...updatedMember, feishuId: 'feishu-global' });
  writeUserMember(memberPath, { ...updatedMember, feishuId: '' });
  assert.deepEqual(JSON.parse(readFileSync(memberPath, 'utf8')), updatedMember);
  assert.throws(() => writeUserMember(memberPath, { ...member, displayName: '坏\n名称' }), /包含换行符/);
  assert.deepEqual(readMemberFromEnvContent('YUNXIAO_DISPLAY_NAME="旧成员"\nYUNXIAO_USER_ID="legacy-user"\n'), {
    displayName: '旧成员',
    userId: 'legacy-user',
  });
  rmSync(symlinkRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
  rmSync(conflictRoot, { recursive: true, force: true });
  rmSync(legacyRoot, { recursive: true, force: true });
  rmSync(ignoredAgentsRoot, { recursive: true, force: true });
  rmSync(simpleRoot, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
  console.log('configure self-test passed');
};

run();
