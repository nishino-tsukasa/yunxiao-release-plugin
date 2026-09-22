#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { deployEnvironment, planEnvironmentDeployment } from './deploy-environment.mjs';

const writeJson = (filePath, value) => writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);

const git = (cwd, args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} 失败`);
  }
  return result.stdout.trim();
};

const readRequestBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

// 使用真实 bare remote 覆盖自动发布主路径，并证明生产入口不会修改 Git。
const run = async () => {
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Yunxiao Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Yunxiao Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  });
  const testRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-deploy-test-'));
  const remote = resolve(testRoot, 'remote.git');
  const repo = resolve(testRoot, 'repo');
  const requests = [];
  const server = createServer(async (request, response) => {
    requests.push({ method: request.method, body: await readRequestBody(request) });
    response.writeHead(204).end();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address();
    git(testRoot, ['init', '--bare', remote]);
    git(testRoot, ['init', '-b', 'release', repo]);
    git(repo, ['remote', 'add', 'origin', remote]);
    mkdirSync(resolve(repo, '.agents'));
    writeFileSync(resolve(repo, '.gitignore'), '/.agents/yunxiao-release.local.json\n/.agents/runtime/\n');
    writeJson(resolve(repo, '.agents/yunxiao-release.json'), {
      organizationId: 'org-1',
      repositoryId: 'repo-1',
      remoteName: 'origin',
      targetBranch: 'release',
      reviewerMode: 'ask',
      reviewerUserIds: [],
      versionFile: null,
      announcementFile: null,
      localConfigFile: '.agents/yunxiao-release.local.json',
      runtimeFile: '.agents/runtime/yunxiao-release-mr.json',
      commentsFile: '.agents/runtime/yunxiao-release-comments.md',
      validationCommands: ['git diff --check'],
      testDeployments: [
        {
          environment: 'fat',
          targetBranch: 'develop',
          hookUrl: `http://127.0.0.1:${port}/hook`,
          webUrl: 'https://example.com/fat',
        },
        { environment: 'production', webUrl: 'https://example.com/production' },
      ],
    });
    writeFileSync(resolve(repo, 'base.txt'), 'base\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'base']);
    git(repo, ['push', '-u', 'origin', 'release']);
    git(repo, ['branch', 'develop']);
    git(repo, ['push', 'origin', 'develop']);
    git(repo, ['switch', '-c', 'feature/example']);
    writeFileSync(resolve(repo, 'feature.txt'), 'feature\n');
    git(repo, ['add', 'feature.txt']);
    git(repo, ['commit', '-m', 'feature']);
    git(repo, ['switch', 'release']);
    writeFileSync(resolve(repo, 'release.txt'), 'release\n');
    git(repo, ['add', 'release.txt']);
    git(repo, ['commit', '-m', 'release']);
    git(repo, ['push', 'origin', 'release']);
    git(repo, ['switch', 'feature/example']);
    writeJson(resolve(repo, '.agents/yunxiao-release.local.json'), {
      displayName: '项目成员',
      userId: 'user-1',
      feishuId: 'project-feishu',
    });

    const beforeProduction = git(repo, ['rev-parse', 'HEAD']);
    assert.deepEqual(planEnvironmentDeployment(repo, 'production'), {
      mode: 'manual',
      environment: 'production',
      webUrl: 'https://example.com/production',
    });
    assert.equal(git(repo, ['rev-parse', 'HEAD']), beforeProduction);

    const xdgConfigHome = resolve(testRoot, 'xdg-config');
    mkdirSync(resolve(xdgConfigHome, 'yunxiao-release'), { recursive: true });
    writeJson(resolve(xdgConfigHome, 'yunxiao-release/member.json'), {
      displayName: '用户成员',
      userId: 'user-2',
      feishuId: 'global-feishu',
    });
    rmSync(resolve(repo, '.agents/yunxiao-release.local.json'));
    assert.equal(
      planEnvironmentDeployment(repo, 'fat', { ...process.env, XDG_CONFIG_HOME: xdgConfigHome }).mode,
      'automatic',
    );
    writeJson(resolve(repo, '.agents/yunxiao-release.local.json'), {
      displayName: '项目成员',
      userId: 'user-1',
      feishuId: 'project-feishu',
    });

    const result = await deployEnvironment(repo, 'fat');
    assert.equal(result.webhookTriggered, true);
    assert.equal(readFileSync(resolve(repo, 'release.txt'), 'utf8'), 'release\n');
    const remoteDevelop = git(repo, ['ls-remote', '--heads', 'origin', 'refs/heads/develop']).split(/\s+/)[0];
    assert.equal(git(repo, ['show', `${remoteDevelop}:feature.txt`]), 'feature');
    assert.equal(git(repo, ['show', `${remoteDevelop}:release.txt`]), 'release');
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1);
    assert.deepEqual(requests, [
      { method: 'POST', body: JSON.stringify({ feishuId: 'project-feishu', branch: 'develop' }) },
    ]);
    const emptyConfigHome = resolve(testRoot, 'empty-config');
    const emptyCodexHome = resolve(testRoot, 'empty-codex');
    mkdirSync(emptyConfigHome);
    mkdirSync(emptyCodexHome);
    writeJson(resolve(repo, '.agents/yunxiao-release.local.json'), {
      displayName: '项目成员',
      userId: 'user-1',
    });
    await deployEnvironment(repo, 'fat', {
      env: { ...process.env, XDG_CONFIG_HOME: emptyConfigHome, CODEX_HOME: emptyCodexHome },
    });
    assert.deepEqual(requests.at(-1), {
      method: 'POST',
      body: JSON.stringify({ branch: 'develop' }),
    });
    await assert.rejects(
      () => deployEnvironment(repo, 'fat', { fetchImpl: async () => ({ ok: false, status: 500 }) }),
      /代码已推送，但构建未触发: Webhook 返回 HTTP 500/,
    );
    assert.equal(git(repo, ['worktree', 'list', '--porcelain']).match(/^worktree /gm)?.length, 1);
    writeFileSync(resolve(repo, 'dirty.txt'), 'dirty\n');
    assert.throws(() => planEnvironmentDeployment(repo, 'fat'), /工作区干净/);
    console.log('deploy environment self-test passed');
  } finally {
    server.close();
    rmSync(testRoot, { recursive: true, force: true });
  }
};

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
