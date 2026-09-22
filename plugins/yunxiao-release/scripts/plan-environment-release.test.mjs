#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-plan-cli-'));
const defaultsPath = resolve(root, 'global-defaults.json');
const repositoriesPath = resolve(root, 'global-repositories.json');
const outputPath = resolve(root, 'plan.json');
const repositoryKey = 'example.com/team/backend-app';
const scriptsDir = dirname(fileURLToPath(import.meta.url));

writeFileSync(defaultsPath, `${JSON.stringify({
  schemaVersion: 1,
  organizationId: 'org-1',
  releaseExecution: { pollIntervalSeconds: 1, clientInitialWaitSeconds: 0, clientTimeoutSeconds: 10, serverTimeoutSeconds: 10 },
})}\n`);
writeFileSync(repositoriesPath, `${JSON.stringify({
  schemaVersion: 1,
  repositories: {
    [repositoryKey]: {
      repositoryId: '1', remoteName: 'origin', targetBranch: 'release', reviewerMode: 'ask', reviewerUserIds: [],
      versionFile: null, announcementFile: null, localConfigFile: '.agents/local.json', runtimeFile: '.agents/runtime.json',
      commentsFile: '.agents/comments.md', validationCommands: ['git diff --check'],
      environments: {
        fat: {
          branch: 'testing',
          steps: [{ type: 'pipeline', stage: 'backend-server-deploy', pipelineName: 'server', pipelineId: '200', params: { envs: {} } }],
        },
      },
    },
  },
})}\n`);

try {
  const result = spawnSync('node', [
    resolve(scriptsDir, 'fat-flow/plan_environment_release.mjs'),
    '--repository-keys', repositoryKey, '--client-repository-keys', '', '--branch', 'feature/demo',
    '--defaults-config', defaultsPath, '--repositories-config', repositoriesPath, '--output', outputPath,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(readFileSync(outputPath));
  assert.deepEqual(plan.stages.map(({ name }) => name), ['frontend-client-deploy', 'backend-client-package', 'backend-server-deploy']);
  assert.equal(plan.stages[2].steps[0].pipelineId, '200');
  assert.deepEqual(plan.unresolved, []);

  const configHome = resolve(root, 'config');
  const configDir = resolve(configHome, 'yunxiao-release');
  const repository = resolve(root, 'renamed-worktree');
  const overrideOutput = resolve(root, 'override-plan.json');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(repository);
  writeFileSync(resolve(configDir, 'global-defaults.json'), readFileSync(defaultsPath));
  writeFileSync(resolve(configDir, 'global-repositories.json'), readFileSync(repositoriesPath));
  spawnSync('git', ['init', '-q'], { cwd: repository });
  spawnSync('git', ['remote', 'add', 'origin', 'git@example.com:team/backend-app.git'], { cwd: repository });
  mkdirSync(resolve(repository, '.agents'));
  writeFileSync(resolve(repository, '.agents/yunxiao-release.json'), `${JSON.stringify({
    organizationId: 'org-1', repositoryId: 'project-1', remoteName: 'origin', targetBranch: 'release',
    reviewerMode: 'ask', reviewerUserIds: [], versionFile: null, announcementFile: null,
    localConfigFile: '.agents/local.json', runtimeFile: '.agents/runtime.json', commentsFile: '.agents/comments.md',
    validationCommands: ['git diff --check'],
    environments: {
      fat: {
        branch: 'project-testing',
        steps: [{ type: 'pipeline', stage: 'backend-server-deploy', pipelineName: 'project-server', pipelineId: '201', params: { envs: {} } }],
      },
    },
  })}\n`);
  const overrideResult = spawnSync('node', [
    resolve(scriptsDir, 'fat-flow/plan_environment_release.mjs'),
    '--repos', repository, '--client-repos', '', '--branch', 'feature/demo', '--output', overrideOutput,
  ], { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_CONFIG_HOME: configHome } });
  assert.equal(overrideResult.status, 0, overrideResult.stderr);
  const overridePlan = JSON.parse(readFileSync(overrideOutput));
  assert.equal(overridePlan.branch, 'project-testing');
  assert.equal(overridePlan.stages[2].steps[0].pipelineId, '201');
  console.log('environment release CLI self-test passed');
} finally {
  rmSync(root, { recursive: true, force: true });
}
