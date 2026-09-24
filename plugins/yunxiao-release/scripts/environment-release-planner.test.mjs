#!/usr/bin/env node

import assert from 'node:assert/strict';

import { planEnvironmentRelease } from './environment-release-planner.mjs';

const profile = (repositoryKey, steps) => ({
  project: repositoryKey.split('/').at(-1),
  repository: { repositoryKey, repositoryId: repositoryKey, remoteName: 'origin' },
  mergeRequest: { targetBranch: 'release' },
  git: { commitMessagePattern: '^feat:' },
  environments: { fat: { branch: 'testing', steps } },
});

{
  const plan = planEnvironmentRelease({
    environment: 'fat',
    repositories: [{
      profile: profile('example.com/team/frontend-app', [
        { type: 'promote-branch' },
        { type: 'webhook', hookUrl: 'https://example.com/hook' },
      ]),
      sourceBranch: 'feature/demo',
      changedFiles: ['src/page.js'],
    }],
  });
  assert.deepEqual(plan.stages.map(({ name }) => name), ['promote-branch', 'webhook']);
  assert.equal(plan.stages[0].steps[0].targetBranch, 'testing');
  assert.equal(plan.stages[0].steps[0].prerequisiteBranch, 'release');
  assert.equal(plan.stages[1].steps[0].hookUrl, 'https://example.com/hook');
}

{
  const alternatives = [
    { type: 'pipeline', stage: 'backend-client-package', pipelineName: 'client-1', pipelineId: '100', params: { envs: {} } },
    { type: 'pipeline', stage: 'backend-client-package', pipelineName: 'client-2', pipelineId: '101', params: { envs: {} } },
  ];
  const plan = planEnvironmentRelease({
    environment: 'fat',
    repositories: ['a', 'b', 'c'].map((name) => ({
      profile: profile(`example.com/team/${name}`, [{ type: 'pipeline', stage: 'backend-client-package', alternatives }]),
      sourceBranch: 'feature/demo',
      includeClient: true,
    })),
  });
  assert.deepEqual(plan.stages[0].steps.map(({ pipelineId }) => pipelineId), ['100', '101', '100']);
  assert.deepEqual(plan.stages[0].steps[0].candidates.map(({ pipelineId }) => pipelineId), ['100', '101']);
}

{
  const current = profile('example.com/team/backend-app', [{ type: 'promote-branch' }]);
  current.environments.fat.issues = [
    { stage: 'backend-client-package', message: 'missing client' },
    { stage: 'backend-server-deploy', message: 'missing server' },
  ];
  const plan = planEnvironmentRelease({
    environment: 'fat',
    repositories: [{ profile: current, sourceBranch: 'feature/demo', includeClient: true, includeServer: true }],
  });
  assert.deepEqual(plan.unresolved, ['missing client', 'missing server']);
}

{
  const plan = planEnvironmentRelease({
    environment: 'fat',
    repositories: [{
      profile: profile('example.com/team/backend-app', [
        { type: 'promote-branch' },
        { type: 'pipeline', stage: 'backend-client-package', pipelineId: '100', pipelineName: 'client', when: { changedPaths: ['client/'] }, params: { envs: {} } },
        { type: 'pipeline', stage: 'backend-server-deploy', pipelineId: '200', pipelineName: 'server', params: { envs: {} } },
      ]),
      sourceBranch: 'feature/demo',
      changedFiles: ['server/Main.java'],
    }],
  });
  assert.deepEqual(plan.stages.map(({ name }) => name), ['promote-branch', 'backend-server-deploy']);
  assert.equal(plan.stages[1].steps[0].pipelineId, '200');
}

{
  const plan = planEnvironmentRelease({
    environment: 'production',
    repositories: [{
      profile: {
        ...profile('example.com/team/app', []),
        environments: { production: { branch: null, steps: [{ type: 'manual-link', webUrl: 'https://example.com/prod' }] } },
      },
      sourceBranch: 'feature/demo',
      changedFiles: [],
    }],
  });
  assert.deepEqual(plan.stages, [{
    name: 'manual-link',
    steps: [{ type: 'manual-link', project: 'app', repositoryKey: 'example.com/team/app', webUrl: 'https://example.com/prod' }],
  }]);
}

console.log('environment release planner self-test passed');
