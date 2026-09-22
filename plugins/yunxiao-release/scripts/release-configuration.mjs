#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { assertGlobalDefaultScope, readGlobalConfigFiles, readGlobalProjectConfig } from './global-config.mjs';
import { normalizePipelineStage, pipelineStages } from './release-step-schema.mjs';

const projectConfigPath = '.agents/yunxiao-release.json';
const legacyProjectConfigPath = '.codex/yunxiao-release.json';

const fail = (message) => { throw new Error(message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const withoutMissingValues = (value) => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined && item !== ''),
);

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`无法读取 JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const normalizeHttpUrl = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须是非空 HTTP(S) URL`);
  let url;
  try { url = new URL(value); } catch { fail(`${label} 必须是有效 HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) fail(`${label} 只允许 HTTP(S) URL`);
  return url.toString();
};

const readProjectConfigFile = (rootDir) => {
  const current = resolve(rootDir, projectConfigPath);
  const legacy = resolve(rootDir, legacyProjectConfigPath);
  if (existsSync(current) && existsSync(legacy)) fail('新旧项目共享配置同时存在，请确认保留哪一份');
  const source = existsSync(current) ? current : legacy;
  return existsSync(source) ? { exists: true, config: readJson(source) } : { exists: false, config: {} };
};

const renderEnvs = (template, context) => Object.fromEntries(Object.entries(template ?? {}).map(([key, value]) => [
  key,
  String(value).replaceAll('{project}', context.project)
    .replaceAll('{branch}', context.branch)
    .replaceAll('{env}', context.environment)
    .replaceAll('{envName}', context.environmentName)
    .replaceAll('{feishuId}', context.feishuId),
]));

const pipelineStep = (pipeline, stage, context, when) => ({
  type: 'pipeline',
  stage,
  pipelineName: pipeline.name,
  pipelineId: String(pipeline.pipelineId ?? ''),
  params: { envs: renderEnvs(pipeline.envs, context) },
  ...(when ? { when } : {}),
});

const adaptTestDeployments = (deployments) => {
  if (!Array.isArray(deployments)) fail('testDeployments 必须是数组');
  const environments = {};
  for (const [index, deployment] of deployments.entries()) {
    if (!isObject(deployment)) fail(`testDeployments[${index}] 必须是对象`);
    const name = typeof deployment.environment === 'string' ? deployment.environment.trim() : '';
    if (!name) fail(`testDeployments[${index}].environment 无效`);
    if (environments[name]) fail(`testDeployments environment 重复: ${name}`);
    const hasTargetBranch = deployment.targetBranch !== undefined && deployment.targetBranch !== null;
    const hasHookUrl = deployment.hookUrl !== undefined && deployment.hookUrl !== null;
    if (hasTargetBranch !== hasHookUrl) fail(`${name} 的 targetBranch 和 hookUrl 必须同时配置`);
    const automatic = hasTargetBranch;
    if (!automatic) {
      environments[name] = {
        branch: null,
        steps: [{ type: 'manual-link', webUrl: normalizeHttpUrl(deployment.webUrl, `${name}.webUrl`) }],
      };
      continue;
    }
    if (typeof deployment.targetBranch !== 'string' || !deployment.targetBranch.trim()) fail(`${name}.targetBranch 无效`);
    const webhook = {
      type: 'webhook',
      hookUrl: normalizeHttpUrl(deployment.hookUrl, `${name}.hookUrl`),
      ...(deployment.webUrl ? { webUrl: normalizeHttpUrl(deployment.webUrl, `${name}.webUrl`) } : {}),
    };
    environments[name] = { branch: deployment.targetBranch.trim(), steps: [{ type: 'promote-branch' }, webhook] };
  }
  return environments;
};

const clientWhen = (detection) => {
  if (!isObject(detection) || detection.mode === 'always') return null;
  if (detection.mode === 'never') return false;
  if (detection.mode === 'changed-paths' && Array.isArray(detection.pathPrefixes) && detection.pathPrefixes.length) {
    return { changedPaths: detection.pathPrefixes.map(String) };
  }
  fail(`clientDetection 配置无效: ${JSON.stringify(detection)}`);
};

const findClientPipelines = (project, clientPackage) => {
  const candidates = [];
  if (isObject(clientPackage.frameworkPipeline) && clientPackage.frameworkPipeline.projects?.includes(project)) {
    candidates.push(clientPackage.frameworkPipeline);
  }
  for (const pipeline of clientPackage.javaServicePipelines ?? []) {
    if (pipeline.projects?.includes(project)) candidates.push(pipeline);
  }
  return candidates;
};

const adaptFatEnvironment = (project, repository, fatFlow) => {
  if (!isObject(fatFlow) || typeof repository.fatTargetBranch !== 'string' || !repository.fatTargetBranch) return null;
  const branch = repository.fatTargetBranch;
  const steps = [{ type: 'promote-branch' }];
  const issues = [];
  if (repository.projectType === 'frontend') {
    const section = fatFlow.frontendDeploy ?? {};
    const pipeline = section.projects?.[project];
    if (pipeline) {
      const context = {
        project, branch, environment: pipeline.env ?? section.defaultEnv ?? 'fat',
        environmentName: pipeline.envName ?? section.defaultEnvName ?? '', feishuId: pipeline.feishuId ?? section.defaultFeishuId ?? '',
      };
      steps.push(pipelineStep(pipeline, 'frontend-client-deploy', context));
    } else issues.push({ stage: 'frontend-client-deploy', message: `项目 ${project} 未配置 frontend 部署流水线映射` });
  } else {
    const client = fatFlow.clientPackage ?? {};
    const when = clientWhen(repository.clientDetection);
    if (when !== false && !(client.skipProjects ?? []).includes(project)) {
      const pipelines = findClientPipelines(project, client);
      if (pipelines.length) {
        const context = {
          project, branch, environment: client.defaultEnv ?? 'fat', environmentName: '',
          feishuId: client.defaultFeishuId ?? '',
        };
        const alternatives = pipelines.map((pipeline) => pipelineStep(pipeline, 'backend-client-package', {
          ...context, feishuId: pipeline.feishuId ?? context.feishuId,
        }, when));
        steps.push(alternatives.length === 1 ? alternatives[0] : {
          type: 'pipeline', stage: 'backend-client-package', alternatives,
          ...(when ? { when } : {}),
        });
      } else issues.push({ stage: 'backend-client-package', message: `项目 ${project} 未配置 client 打包流水线映射` });
    }
    const server = fatFlow.serverDeploy ?? {};
    const pipeline = (server.skipProjects ?? []).includes(project) ? null : server.projects?.[project];
    if (pipeline) {
      const context = {
        project, branch, environment: pipeline.env ?? server.defaultEnv ?? 'fat',
        environmentName: '', feishuId: pipeline.feishuId ?? '',
      };
      steps.push(pipelineStep(pipeline, 'backend-server-deploy', context));
    } else if (!(server.skipProjects ?? []).includes(project)) {
      issues.push({ stage: 'backend-server-deploy', message: `项目 ${project} 未配置 server 部署流水线映射` });
    }
  }
  return { branch, steps, issues };
};

const normalizeStep = (step, label) => {
  if (!isObject(step) || typeof step.type !== 'string') fail(`${label} 必须声明 type`);
  if (step.type === 'promote-branch') return { type: 'promote-branch' };
  if (step.type === 'webhook') {
    return {
      type: 'webhook',
      hookUrl: normalizeHttpUrl(step.hookUrl, `${label}.hookUrl`),
      ...(step.webUrl ? { webUrl: normalizeHttpUrl(step.webUrl, `${label}.webUrl`) } : {}),
    };
  }
  if (step.type === 'manual-link') {
    return { type: 'manual-link', webUrl: normalizeHttpUrl(step.webUrl, `${label}.webUrl`) };
  }
  if (step.type === 'pipeline') {
    const stage = normalizePipelineStage(step.stage);
    if (typeof stage !== 'string' || !pipelineStages.includes(stage)) fail(`${label}.stage 不支持: ${step.stage ?? ''}`);
    if (step.when !== undefined && (
      !isObject(step.when)
      || !Array.isArray(step.when.changedPaths)
      || Object.keys(step.when).some((key) => key !== 'changedPaths')
    )) {
      fail(`${label}.when 仅支持 changedPaths 数组`);
    }
    const common = {
      type: 'pipeline',
      stage,
      ...(step.when ? { when: { changedPaths: step.when.changedPaths.map(String) } } : {}),
    };
    if (step.candidates !== undefined) {
      if (!Array.isArray(step.candidates) || step.candidates.length === 0) fail(`${label}.candidates 必须是非空数组`);
      return {
        ...common,
        alternatives: step.candidates.map((candidate, index) => {
          if (!isObject(candidate)) fail(`${label}.candidates[${index}] 必须是对象`);
          if (typeof candidate.pipelineName !== 'string' || !candidate.pipelineName.trim()) {
            fail(`${label}.candidates[${index}].pipelineName 必须是非空字符串`);
          }
          if (candidate.pipelineId === undefined || !String(candidate.pipelineId).trim()) {
            fail(`${label}.candidates[${index}].pipelineId 必须是非空字符串`);
          }
          return {
            ...common,
            pipelineName: candidate.pipelineName.trim(),
            pipelineId: String(candidate.pipelineId).trim(),
            params: isObject(candidate.params) ? candidate.params : { envs: {} },
          };
        }),
      };
    }
    if (typeof step.pipelineName !== 'string' || !step.pipelineName.trim()) {
      fail(`${label}.pipelineName 必须是非空字符串`);
    }
    if (step.pipelineId === undefined || !String(step.pipelineId).trim()) {
      fail(`${label}.pipelineId 必须是非空字符串`);
    }
    return {
      ...common,
      pipelineName: step.pipelineName.trim(),
      pipelineId: String(step.pipelineId).trim(),
      params: isObject(step.params) ? step.params : { envs: {} },
    };
  }
  fail(`${label}.type 不支持: ${step.type}`);
};

const normalizeStageExecution = (value, stage) => {
  if (!isObject(value)) fail(`releaseExecution.stages.${stage} 必须是对象`);
  const timeoutSeconds = value.timeoutSeconds;
  const initialWaitSeconds = value.initialWaitSeconds ?? 0;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
    fail(`releaseExecution.stages.${stage}.timeoutSeconds 必须是非负整数`);
  }
  if (!Number.isInteger(initialWaitSeconds) || initialWaitSeconds < 0) {
    fail(`releaseExecution.stages.${stage}.initialWaitSeconds 必须是非负整数`);
  }
  return { initialWaitSeconds, timeoutSeconds };
};

const adaptLegacyExecution = (value) => ({
  pollIntervalSeconds: value.pollIntervalSeconds,
  stages: {
    'frontend-client-deploy': { initialWaitSeconds: 0, timeoutSeconds: value.serverTimeoutSeconds },
    'backend-client-package': {
      initialWaitSeconds: value.clientInitialWaitSeconds,
      timeoutSeconds: value.clientTimeoutSeconds,
    },
    'backend-server-deploy': { initialWaitSeconds: 0, timeoutSeconds: value.serverTimeoutSeconds },
  },
});

const normalizeExecution = (value, requiredStages) => {
  if (requiredStages.length === 0 && value === undefined) return {};
  if (!isObject(value)) fail('releaseExecution 必须是对象');
  const canonical = value.stages === undefined ? adaptLegacyExecution(value) : value;
  if (!Number.isInteger(canonical.pollIntervalSeconds) || canonical.pollIntervalSeconds < 0) {
    fail('releaseExecution.pollIntervalSeconds 必须是非负整数');
  }
  if (!isObject(canonical.stages)) fail('releaseExecution.stages 必须是对象');
  const missing = requiredStages.filter((stage) => !isObject(canonical.stages[stage]));
  if (missing.length) fail(`releaseExecution.stages 缺少阶段: ${missing.join(', ')}`);
  const normalizedStages = {};
  for (const [stage, execution] of Object.entries(canonical.stages)) {
    const normalizedStage = normalizePipelineStage(stage);
    if (!pipelineStages.includes(normalizedStage)) fail(`releaseExecution.stages 不支持阶段: ${stage}`);
    if (Object.hasOwn(normalizedStages, normalizedStage)) fail(`releaseExecution.stages 阶段重复: ${normalizedStage}`);
    normalizedStages[normalizedStage] = normalizeStageExecution(execution, normalizedStage);
  }
  return {
    pollIntervalSeconds: canonical.pollIntervalSeconds,
    stages: Object.fromEntries(pipelineStages.filter((stage) => Object.hasOwn(normalizedStages, stage))
      .map((stage) => [stage, normalizedStages[stage]])),
  };
};

const normalizeEnvironments = (value) => {
  if (!isObject(value)) fail('environments 必须是对象');
  return Object.fromEntries(Object.entries(value).map(([name, environment]) => {
    if (!isObject(environment) || !Array.isArray(environment.steps)) fail(`environments.${name} 配置无效`);
    const branch = environment.branch ?? null;
    if (branch !== null && (typeof branch !== 'string' || !branch.trim())) fail(`environments.${name}.branch 无效`);
    const steps = environment.steps.map((step, index) => normalizeStep(step, `environments.${name}.steps[${index}]`));
    if (steps.some(({ type }) => type === 'pipeline') && steps.some(({ type }) => type === 'webhook')) {
      fail(`environments.${name} 不能同时配置 pipeline 和 webhook`);
    }
    return [name, {
      branch: typeof branch === 'string' ? branch.trim() : null,
      steps,
    }];
  }));
};

const assertExclusiveTriggers = (environments) => {
  for (const [name, environment] of Object.entries(environments)) {
    if (environment.steps.some(({ type }) => type === 'pipeline') && environment.steps.some(({ type }) => type === 'webhook')) {
      fail(`environments.${name} 不能同时配置 pipeline 和 webhook`);
    }
  }
};

const buildProfile = ({ project, repositoryKey, defaults, repositoryConfig }) => {
  const raw = { ...defaults, ...withoutMissingValues(repositoryConfig) };
  const required = [
    'organizationId', 'repositoryId', 'remoteName', 'targetBranch', 'reviewerMode', 'reviewerUserIds',
    'versionFile', 'announcementFile', 'localConfigFile', 'runtimeFile', 'commentsFile', 'validationCommands',
  ];
  const missing = required.filter((key) => raw[key] === undefined || raw[key] === '');
  if (missing.length) fail(`合并后的项目配置缺少字段: ${missing.join(', ')}`);
  const hasCanonicalEnvironments = raw.environments !== undefined;
  const environments = hasCanonicalEnvironments
    ? normalizeEnvironments(raw.environments)
    : adaptTestDeployments(raw.testDeployments ?? []);
  const fat = hasCanonicalEnvironments ? null : adaptFatEnvironment(project, raw, defaults.fatFlow);
  if (fat) {
    if (!environments.fat) environments.fat = fat;
    else {
      environments.fat.steps.push(...fat.steps.filter((step) => step.type !== 'promote-branch'));
      environments.fat.issues = fat.issues;
    }
  }
  if (!hasCanonicalEnvironments && environments.fat?.steps.some(({ type }) => type === 'pipeline')) {
    environments.fat.steps = environments.fat.steps.filter(({ type }) => type !== 'webhook');
  }
  assertExclusiveTriggers(environments);
  const requiredStages = [...new Set(Object.values(environments).flatMap((environment) => environment.steps
    .filter((step) => step.type === 'pipeline')
    .map((step) => step.stage)))];
  const execution = normalizeExecution(raw.releaseExecution ?? defaults.fatFlow?.execution, requiredStages);
  return {
    schemaVersion: 1,
    project,
    organizationId: raw.organizationId,
    repository: {
      repositoryKey,
      repositoryId: String(raw.repositoryId),
      remoteName: raw.remoteName,
    },
    mergeRequest: {
      targetBranch: raw.targetBranch,
      reviewerMode: raw.reviewerMode,
      reviewerUserIds: raw.reviewerUserIds,
    },
    artifacts: { versionFile: raw.versionFile, announcementFile: raw.announcementFile },
    storage: {
      localConfigFile: raw.localConfigFile,
      runtimeFile: raw.runtimeFile,
      commentsFile: raw.commentsFile,
    },
    validationCommands: raw.validationCommands,
    git: { ...(raw.commitMessagePattern ? { commitMessagePattern: raw.commitMessagePattern } : {}) },
    environments,
    execution,
  };
};

export const resolveReleaseConfiguration = (rootDir, env = process.env) => {
  const projectSource = readProjectConfigFile(rootDir);
  const projectConfig = projectSource.config;
  const initial = readGlobalProjectConfig(rootDir, env, projectConfig.remoteName || '');
  const remoteName = projectConfig.remoteName || initial.remoteName;
  const global = remoteName && remoteName !== initial.remoteName
    ? readGlobalProjectConfig(rootDir, env, remoteName)
    : initial;
  const repositoryConfig = projectSource.exists
    ? projectConfig
    : (global.repositoryKey ? global.repositories[global.repositoryKey] ?? {} : {});
  const project = (global.repositoryKey ?? rootDir).split('/').at(-1);
  return buildProfile({
    project,
    repositoryKey: global.repositoryKey,
    defaults: global.defaults,
    repositoryConfig,
  });
};

const readConfiguredGlobal = (env, files) => {
  const global = files.defaultsPath || files.repositoriesPath
    ? (() => {
      if (!files.defaultsPath || !files.repositoriesPath) fail('必须同时提供 defaultsPath 和 repositoriesPath');
      const rawDefaults = readJson(files.defaultsPath);
      const rawRepositories = readJson(files.repositoriesPath);
      if (rawDefaults.schemaVersion !== undefined && rawDefaults.schemaVersion !== 1) fail('全局默认配置 schemaVersion 必须为 1');
      if (rawRepositories.schemaVersion !== undefined && rawRepositories.schemaVersion !== 1) fail('全局仓库配置 schemaVersion 必须为 1');
      if (!isObject(rawRepositories.repositories ?? {})) fail('全局 repositories 必须是对象');
      const { schemaVersion: _defaultsVersion, ...defaults } = rawDefaults;
      return { defaults, repositories: rawRepositories.repositories ?? {} };
    })()
    : readGlobalConfigFiles(env);
  if (global.source !== 'legacy') assertGlobalDefaultScope(global.defaults);
  return global;
};

export const resolveReleaseConfigurationForRepositoryKey = (repositoryKey, env = process.env, files = {}) => {
  const global = readConfiguredGlobal(env, files);
  const repositoryConfig = global.repositories[repositoryKey];
  if (!repositoryConfig) fail(`全局仓库配置未登记 repositoryKey: ${repositoryKey}`);
  const project = repositoryKey.split('/').at(-1);
  return buildProfile({ project, repositoryKey, defaults: global.defaults, repositoryConfig });
};

export const resolveReleaseConfigurationForProject = (project, env = process.env, files = {}) => {
  const global = readConfiguredGlobal(env, files);
  const matches = Object.entries(global.repositories).filter(([key]) => key.split('/').at(-1) === project);
  if (matches.length === 0) fail(`全局仓库配置未登记项目: ${project}`);
  if (matches.length > 1) fail(`仓库项目名不唯一，必须使用 repo 定位: ${project}`);
  const [[repositoryKey, repositoryConfig]] = matches;
  return buildProfile({ project, repositoryKey, defaults: global.defaults, repositoryConfig });
};

export const releaseConfigurationAsLegacyProjectConfig = (profile) => ({
  organizationId: profile.organizationId,
  repositoryId: profile.repository.repositoryId,
  remoteName: profile.repository.remoteName,
  targetBranch: profile.mergeRequest.targetBranch,
  reviewerMode: profile.mergeRequest.reviewerMode,
  reviewerUserIds: profile.mergeRequest.reviewerUserIds,
  versionFile: profile.artifacts.versionFile,
  announcementFile: profile.artifacts.announcementFile,
  localConfigFile: profile.storage.localConfigFile,
  runtimeFile: profile.storage.runtimeFile,
  commentsFile: profile.storage.commentsFile,
  validationCommands: profile.validationCommands,
  testDeployments: Object.entries(profile.environments).flatMap(([environment, value]) => {
    const manual = value.steps.find((step) => step.type === 'manual-link');
    if (manual) return [{ environment, webUrl: manual.webUrl }];
    const webhook = value.steps.find((step) => step.type === 'webhook');
    if (!webhook) return [];
    return [{ environment, targetBranch: value.branch, hookUrl: webhook.hookUrl, ...(webhook.webUrl ? { webUrl: webhook.webUrl } : {}) }];
  }),
});
