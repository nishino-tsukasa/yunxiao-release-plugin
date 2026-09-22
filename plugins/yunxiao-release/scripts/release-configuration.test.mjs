#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { resolveReleaseConfiguration, resolveReleaseConfigurationForProject } from './release-configuration.mjs';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const createFixture = ({ defaults = {}, repository = {}, project = null, legacy = false } = {}) => {
  const root = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-profile-'));
  const configHome = resolve(root, 'config');
  const repositoryRoot = resolve(root, 'repo');
  mkdirSync(repositoryRoot);
  execFileSync('git', ['init', '-q'], { cwd: repositoryRoot });
  execFileSync('git', ['remote', 'add', 'origin', 'git@example.com:team/backend-app.git'], { cwd: repositoryRoot });
  mkdirSync(resolve(configHome, 'yunxiao-release'), { recursive: true });
  if (legacy) {
    writeJson(resolve(configHome, 'yunxiao-release/projects.json'), {
      defaults,
      repositories: { 'example.com/team/backend-app': repository },
    });
  } else {
    writeJson(resolve(configHome, 'yunxiao-release/global-defaults.json'), { schemaVersion: 1, ...defaults });
    writeJson(resolve(configHome, 'yunxiao-release/global-repositories.json'), {
      schemaVersion: 1,
      repositories: { 'example.com/team/backend-app': repository },
    });
  }
  if (project) {
    mkdirSync(resolve(repositoryRoot, '.agents'));
    writeJson(resolve(repositoryRoot, '.agents/yunxiao-release.json'), project);
  }
  return { root, repositoryRoot, env: { HOME: root, XDG_CONFIG_HOME: configHome } };
};

const common = {
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
};

{
  const fixture = createFixture({
    defaults: { organizationId: 'org-1' },
    repository: {
      ...common,
      testDeployments: [
        { environment: 'fat', targetBranch: 'develop', hookUrl: 'https://example.com/hook', webUrl: 'https://example.com/flow' },
        { environment: 'production', webUrl: 'https://example.com/production' },
      ],
    },
  });
  try {
    const profile = resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env);
    assert.equal(profile.repository.repositoryId, 'repo-1');
    assert.equal(profile.repository.remoteName, 'origin');
    assert.equal(profile.mergeRequest.targetBranch, 'release');
    assert.deepEqual(profile.environments.fat, {
      branch: 'develop',
      steps: [
        { type: 'promote-branch' },
        { type: 'webhook', hookUrl: 'https://example.com/hook', webUrl: 'https://example.com/flow' },
      ],
    });
    assert.deepEqual(profile.environments.production, {
      branch: null,
      steps: [{ type: 'manual-link', webUrl: 'https://example.com/production' }],
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture({
    defaults: {
      organizationId: 'org-1',
      releaseExecution: { pollIntervalSeconds: 10, clientInitialWaitSeconds: 60, clientTimeoutSeconds: 600, serverTimeoutSeconds: 1800 },
    },
    repository: {
      ...common,
      projectType: 'frontend',
      fatTargetBranch: 'legacy-fat',
      environments: {
        fat: {
          branch: 'testing',
          steps: [
            { type: 'promote-branch' },
            { type: 'pipeline', stage: 'server-deploy', pipelineName: 'canonical', pipelineId: '200', params: { envs: { branch: 'testing' } } },
          ],
        },
      },
    },
  });
  try {
    const profile = resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env);
    assert.equal(profile.environments.fat.branch, 'testing');
    assert.deepEqual(profile.environments.fat.steps.map(({ type, pipelineId }) => [type, pipelineId]), [
      ['promote-branch', undefined],
      ['pipeline', '200'],
    ]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture({
    legacy: true,
    defaults: {
      organizationId: 'org-1',
      fatFlow: {
        clientPackage: {
          defaultEnv: 'fat',
          defaultFeishuId: '',
          skipProjects: [],
          frameworkPipeline: {},
          javaServicePipelines: [
            {
              name: 'client-build-1', pipelineId: '100', projects: ['backend-app'],
              envs: { branch: '{branch}', project: '{project}', env: '{env}' },
            },
            {
              name: 'client-build-2', pipelineId: '101', projects: ['backend-app'],
              envs: { branch: '{branch}', project: '{project}', env: '{env}' },
            },
          ],
        },
        serverDeploy: {
          defaultEnv: 'fat', skipProjects: [],
          projects: { 'backend-app': { name: 'server-deploy', pipelineId: '200', envs: { branch: '{branch}', project: '{project}' } } },
        },
        frontendDeploy: { defaultEnv: 'fat', defaultEnvName: 'default', projects: {} },
        execution: { pollIntervalSeconds: 10, clientInitialWaitSeconds: 60, clientTimeoutSeconds: 600, serverTimeoutSeconds: 1800 },
      },
    },
    repository: {
      ...common,
      projectType: 'backend',
      fatTargetBranch: 'fat/fat',
      commitMessagePattern: '^feat:',
      clientDetection: { mode: 'changed-paths', pathPrefixes: ['client/'] },
      testDeployments: [],
    },
  });
  try {
    const profile = resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env);
    assert.equal(profile.environments.fat.branch, 'fat/fat');
    assert.deepEqual(profile.environments.fat.steps.map(({ type, stage }) => [type, stage]), [
      ['promote-branch', undefined],
      ['pipeline', 'client-package'],
      ['pipeline', 'server-deploy'],
    ]);
    assert.deepEqual(profile.environments.fat.steps[1].when, { changedPaths: ['client/'] });
    assert.deepEqual(profile.environments.fat.steps[1].alternatives.map(({ pipelineId }) => pipelineId), ['100', '101']);
    assert.equal(profile.environments.fat.steps[2].pipelineId, '200');
    assert.equal(profile.git.commitMessagePattern, '^feat:');
    assert.equal(resolveReleaseConfigurationForProject('backend-app', fixture.env).environments.fat.branch, 'fat/fat');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture({
    legacy: true,
    defaults: {
      organizationId: 'org-1',
      fatFlow: {
        clientPackage: { defaultEnv: 'fat', skipProjects: [], frameworkPipeline: {}, javaServicePipelines: [] },
        serverDeploy: { defaultEnv: 'fat', skipProjects: [], projects: {} },
        frontendDeploy: { defaultEnv: 'fat', defaultEnvName: 'default', projects: {} },
        execution: { pollIntervalSeconds: 10, clientInitialWaitSeconds: 60, clientTimeoutSeconds: 600, serverTimeoutSeconds: 1800 },
      },
    },
    repository: {
      ...common,
      projectType: 'backend',
      fatTargetBranch: 'fat/fat',
      clientDetection: { mode: 'always' },
      testDeployments: [],
    },
  });
  try {
    const profile = resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env);
    assert.deepEqual(profile.environments.fat.issues.map(({ stage }) => stage), ['client-package', 'server-deploy']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture({
    defaults: { organizationId: 'org-1' },
    repository: {
      ...common,
      environments: { fat: { branch: 'testing', steps: [{ type: 'pipeline', stage: 'server-depoy', pipelineId: '200' }] } },
    },
  });
  try {
    assert.throws(() => resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env), /stage 不支持: server-depoy/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture({
    defaults: { organizationId: 'org-1' },
    repository: {
      ...common,
      environments: { fat: { branch: 'testing', steps: [{ type: 'pipeline', stage: 'server-deploy', pipelineId: '200' }] } },
    },
  });
  try {
    assert.throws(() => resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env), /releaseExecution 必须是对象/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

{
  const fixture = createFixture({
    defaults: { organizationId: 'org-1', targetBranch: 'must-not-inherit' },
    repository: { ...common, targetBranch: undefined, testDeployments: [] },
  });
  try {
    assert.throws(
      () => resolveReleaseConfiguration(fixture.repositoryRoot, fixture.env),
      /全局默认配置不能包含仓库差异字段: targetBranch/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
}

console.log('release configuration self-test passed');
