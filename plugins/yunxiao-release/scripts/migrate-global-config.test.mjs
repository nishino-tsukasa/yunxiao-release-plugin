#!/usr/bin/env node

import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { migrateGlobalConfiguration, prepareProjectConfiguration } from './migrate-global-config.mjs';

const defaults = {
  organizationId: 'org-1',
  releaseExecution: {
    pollIntervalSeconds: 10,
    clientInitialWaitSeconds: 60,
    clientTimeoutSeconds: 600,
    serverTimeoutSeconds: 1800,
  },
};
const repositories = {
  'codeup.aliyun.com/team/frontend-one': {
    repositoryId: '',
    environments: {
      fat: {
        branch: 'develop',
        steps: [
          { type: 'promote-branch' },
          { type: 'webhook', hookUrl: 'https://example.com/hook', webUrl: 'https://flow.aliyun.com/pipelines/100/current' },
        ],
      },
    },
  },
  'codeup.aliyun.com/team/frontend-two': {
    repositoryId: '22',
    environments: {
      fat: {
        branch: 'develop',
        steps: [
          { type: 'promote-branch' },
          { type: 'webhook', hookUrl: 'https://example.com/hook', webUrl: 'https://flow.aliyun.com/pipelines/200/current' },
          { type: 'pipeline', stage: 'frontend-deploy', pipelineName: 'existing', pipelineId: '200', params: { envs: {} } },
        ],
      },
    },
  },
};
const resolver = {
  getRepository: async (_organizationId, repositoryKey) => ({
    id: 11,
    webUrl: `https://${repositoryKey}`,
  }),
  getPipeline: async (_organizationId, pipelineId) => ({
    name: `pipeline-${pipelineId}`,
    pipelineConfig: {
      settings: JSON.stringify({
        globalParams: [
          { key: 'branch', value: 'master' },
          { key: 'project', value: 'unknown' },
          { key: 'envName', value: 'default' },
          { key: 'feishuId', value: 'do-not-copy' },
        ],
      }),
    },
  }),
};

const summary = await migrateGlobalConfiguration({
  defaults,
  repositories,
  resolver,
  resolveRepositoryIds: true,
  webhookStage: 'frontend-client-deploy',
});

assert.equal(summary.executionMigrated, true);
assert.equal(summary.stagesMigrated, 1);
assert.equal(summary.repositoryIdsResolved, 1);
assert.equal(summary.webhooksMigrated, 1);
assert.equal(summary.duplicateWebhooksRemoved, 1);
assert.deepEqual(summary.unresolved, []);
assert.equal(repositories['codeup.aliyun.com/team/frontend-one'].repositoryId, '11');
assert.deepEqual(defaults.releaseExecution.stages['backend-client-package'], {
  initialWaitSeconds: 60,
  timeoutSeconds: 600,
});
const firstSteps = repositories['codeup.aliyun.com/team/frontend-one'].environments.fat.steps;
assert.deepEqual(firstSteps.map(({ type }) => type), ['promote-branch', 'pipeline']);
assert.deepEqual(firstSteps[1], {
  type: 'pipeline',
  stage: 'frontend-client-deploy',
  pipelineName: 'pipeline-100',
  pipelineId: '100',
  params: { envs: {} },
});
const secondSteps = repositories['codeup.aliyun.com/team/frontend-two'].environments.fat.steps;
assert.equal(secondSteps.filter(({ type }) => type === 'webhook').length, 0);
assert.equal(secondSteps.find(({ type }) => type === 'pipeline').stage, 'frontend-client-deploy');

const scopedDefaults = {
  organizationId: 'org-1',
  releaseExecution: { pollIntervalSeconds: 1, clientInitialWaitSeconds: 0, clientTimeoutSeconds: 2, serverTimeoutSeconds: 3 },
};
const scopedRepositories = {
  one: { repositoryId: '', environments: { fat: { branch: 'fat', steps: [] } } },
  two: { repositoryId: '2', environments: { fat: { branch: 'fat', steps: [{ type: 'pipeline', stage: 'server-deploy', pipelineId: '2', pipelineName: 'two' }] } } },
};
const scopedSummary = await migrateGlobalConfiguration({
  defaults: scopedDefaults,
  repositories: scopedRepositories,
  resolver: { getRepository: async () => ({ id: '1', webUrl: 'https://one' }) },
  resolveRepositoryIds: true,
  repositoryKeys: new Set(['one']),
});
assert.equal(scopedSummary.executionMigrated, false);
assert.equal(scopedSummary.stagesMigrated, 0);
assert.equal(scopedRepositories.two.environments.fat.steps[0].stage, 'server-deploy');

const projectRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-project-migration-'));
try {
  spawnSync('git', ['init', '-q'], { cwd: projectRoot });
  spawnSync('git', ['remote', 'add', 'origin', 'git@example.com:team/frontend.git'], { cwd: projectRoot });
  const project = prepareProjectConfiguration({
    rootDir: projectRoot,
    projectConfig: { remoteName: 'origin', repositoryId: '', testDeployments: [{ environment: 'fat' }] },
    defaults,
    repositories: {
      'example.com/team/frontend': {
        repositoryId: '88',
        environments: { fat: { branch: 'develop', steps: [{ type: 'pipeline', stage: 'frontend-client-deploy', pipelineId: '9', pipelineName: 'frontend', params: { envs: { branch: 'develop' } } }] } },
      },
    },
  });
  assert.equal(project.repositoryKey, 'example.com/team/frontend');
  assert.equal(project.config.repositoryId, '88');
  assert.equal(project.config.testDeployments, undefined);
  assert.equal(project.config.environments.fat.steps[0].pipelineId, '9');
  assert.deepEqual(project.config.releaseExecution, defaults.releaseExecution);
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
}

console.log('global config migration self-test passed');
