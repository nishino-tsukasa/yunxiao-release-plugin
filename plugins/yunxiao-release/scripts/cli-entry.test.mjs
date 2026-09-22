#!/usr/bin/env node

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptsDir, '../../..');
const publicCli = resolve(repositoryRoot, 'bin/yunxiao-release.mjs');

// 通过目录别名启动真实 CLI，覆盖 macOS /var 与 /private/var 路径不一致的入口判断。
const run = () => {
  const rootDir = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-cli-'));
  const aliasDir = resolve(rootDir, 'scripts-alias');
  const projectDir = resolve(rootDir, 'project');
  const codexHome = resolve(rootDir, 'codex-home');
  const xdgConfigHome = resolve(rootDir, 'xdg-config');
  symlinkSync(scriptsDir, aliasDir, 'dir');
  execFileSync('git', ['init', projectDir], { stdio: 'ignore' });

  const projectResult = spawnSync('node', [resolve(aliasDir, 'configure-project.mjs')], {
    cwd: projectDir,
    encoding: 'utf8',
  });
  assert.equal(projectResult.status, 0, projectResult.stderr);
  assert.match(projectResult.stdout, /项目配置已写入/);
  const projectConfig = JSON.parse(readFileSync(resolve(projectDir, '.agents/yunxiao-release.json')));
  assert.equal(projectConfig.targetBranch, 'master');
  assert.equal(projectConfig.reviewerMode, 'ask');
  assert.deepEqual(projectConfig.reviewerUserIds, []);

  const missingTokenResult = spawnSync('node', [resolve(aliasDir, 'configure-token.mjs'), '--check'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: rootDir, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(missingTokenResult.status, 1);

  const invalidEnvPath = resolve(xdgConfigHome, 'yunxiao-release/credentials.env');
  mkdirSync(invalidEnvPath, { recursive: true });
  const failedTokenCheckResult = spawnSync('node', [resolve(aliasDir, 'configure-token.mjs'), '--check'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: rootDir, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(failedTokenCheckResult.status, 2);
  rmSync(invalidEnvPath, { recursive: true });

  const tokenResult = spawnSync('node', [resolve(aliasDir, 'configure-token.mjs')], {
    input: 'test-token',
    encoding: 'utf8',
    env: { ...process.env, HOME: rootDir, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(tokenResult.status, 0, tokenResult.stderr);
  assert.equal(existsSync(resolve(codexHome, '.env')), false);
  assert.equal(readFileSync(resolve(xdgConfigHome, 'yunxiao-release/credentials.env'), 'utf8'), 'YUNXIAO_ACCESS_TOKEN=test-token\n');
  const existingTokenResult = spawnSync('node', [resolve(aliasDir, 'configure-token.mjs'), '--check'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: rootDir, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(existingTokenResult.status, 0, existingTokenResult.stderr);

  const memberResult = spawnSync('node', [resolve(aliasDir, 'configure-member.mjs')], {
    input: JSON.stringify({ displayName: '测试成员', userId: 'user-1' }),
    encoding: 'utf8',
    env: { ...process.env, CODEX_HOME: codexHome, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(memberResult.status, 0, memberResult.stderr);
  assert.equal(existsSync(resolve(codexHome, '.env')), false);
  assert.deepEqual(JSON.parse(readFileSync(resolve(xdgConfigHome, 'yunxiao-release/member.json'))), {
    displayName: '测试成员',
    userId: 'user-1',
  });

  const stateResult = spawnSync('node', [resolve(aliasDir, 'release-state.mjs'), '--help'], { encoding: 'utf8' });
  assert.equal(stateResult.status, 0, stateResult.stderr);
  assert.match(stateResult.stdout, /release-state\.mjs check/);

  const helpResult = spawnSync('node', [publicCli, '--help'], { encoding: 'utf8' });
  assert.equal(helpResult.status, 0, helpResult.stderr);
  assert.match(helpResult.stdout, /yunxiao-release configure/);
  const globalResult = spawnSync('node', [publicCli, 'global', '--init'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: rootDir, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(globalResult.status, 0, globalResult.stderr);
  assert.deepEqual(JSON.parse(readFileSync(resolve(xdgConfigHome, 'yunxiao-release/global-defaults.json'))), { schemaVersion: 1 });
  assert.deepEqual(JSON.parse(readFileSync(resolve(xdgConfigHome, 'yunxiao-release/global-repositories.json'))), {
    schemaVersion: 1, repositories: {},
  });
  const globalApplyResult = spawnSync('node', [publicCli, 'global', 'apply'], {
    input: JSON.stringify({ defaults: { organizationId: 'org-1' }, repositories: {} }),
    encoding: 'utf8',
    env: { ...process.env, HOME: rootDir, XDG_CONFIG_HOME: xdgConfigHome },
  });
  assert.equal(globalApplyResult.status, 0, globalApplyResult.stderr);
  assert.deepEqual(JSON.parse(globalApplyResult.stdout), {
    defaultFieldCount: 1, repositoryCount: 0, projectConfigAction: 'not-requested',
  });
  const fatHelpResult = spawnSync('node', [publicCli, 'fat-flow', '--help'], { encoding: 'utf8' });
  assert.equal(fatHelpResult.status, 0, fatHelpResult.stderr);
  assert.match(fatHelpResult.stdout, /run-full-fat-flow-deploy/);
  const cliProject = resolve(rootDir, 'cli-project');
  execFileSync('git', ['init', cliProject], { stdio: 'ignore' });
  const configureResult = spawnSync('node', [publicCli, 'configure'], { cwd: cliProject, encoding: 'utf8' });
  assert.equal(configureResult.status, 0, configureResult.stderr);
  assert.equal(JSON.parse(readFileSync(resolve(cliProject, '.agents/yunxiao-release.json'))).targetBranch, 'master');

  rmSync(rootDir, { recursive: true, force: true });
  console.log('cli entry self-test passed');
};

run();
