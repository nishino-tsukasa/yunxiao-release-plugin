#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { chmodSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeRemoteUrl } from './global-config.mjs';
import { createForwarder } from './yunxiao-mcp-proxy.mjs';
import { normalizePipelineStage, pipelineStages } from './release-step-schema.mjs';

const fail = (message) => { throw new Error(message); };
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

const writeJsonAtomic = (path, value) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
};

const parseToolText = (messages, label) => {
  const response = messages.find((message) => message?.result || message?.error);
  if (response?.error) fail(`${label} 失败: ${response.error.message}`);
  const text = response?.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) fail(`${label} 未返回 JSON`);
  try { return JSON.parse(text); } catch { fail(`${label} 返回无效 JSON`); }
};

export const createYunxiaoResolver = async ({ env = process.env } = {}) => {
  const forward = createForwarder({ env });
  await forward({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'yunxiao-release-migration', version: '1' } },
  });
  let id = 2;
  const call = async (name, args) => parseToolText(await forward({
    jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args },
  }), name);
  return {
    getRepository: (organizationId, repositoryKey) => call('get_repository', {
      organizationId,
      repositoryId: encodeURIComponent(repositoryKey.split('/').slice(1).join('/')),
    }),
    getPipeline: (organizationId, pipelineId) => call('get_pipeline', { organizationId, pipelineId }),
  };
};

const migrateExecution = (defaults) => {
  const value = defaults.releaseExecution;
  if (!isObject(value) || value.stages !== undefined) return false;
  const fields = ['pollIntervalSeconds', 'clientInitialWaitSeconds', 'clientTimeoutSeconds', 'serverTimeoutSeconds'];
  if (fields.some((field) => !Number.isInteger(value[field]) || value[field] < 0)) return false;
  defaults.releaseExecution = {
    pollIntervalSeconds: value.pollIntervalSeconds,
    stages: {
      'frontend-client-deploy': { initialWaitSeconds: 0, timeoutSeconds: value.serverTimeoutSeconds },
      'backend-client-package': {
        initialWaitSeconds: value.clientInitialWaitSeconds,
        timeoutSeconds: value.clientTimeoutSeconds,
      },
      'backend-server-deploy': { initialWaitSeconds: 0, timeoutSeconds: value.serverTimeoutSeconds },
    },
  };
  return true;
};

const pipelineIdFromWebUrl = (value) => {
  if (typeof value !== 'string') return null;
  try {
    const match = new URL(value).pathname.match(/\/pipelines\/(\d+)(?:\/|$)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
};

const projectRepositoryKey = (rootDir, config) => {
  const remoteName = typeof config.remoteName === 'string' && config.remoteName.trim() ? config.remoteName.trim() : 'origin';
  const result = spawnSync('git', ['config', '--get', `remote.${remoteName}.url`], { cwd: rootDir, encoding: 'utf8' });
  if (result.error || result.status !== 0 || !result.stdout.trim()) fail(`无法读取 Git remote: ${remoteName}`);
  const repositoryKey = normalizeRemoteUrl(result.stdout.trim());
  if (!repositoryKey) fail(`Git remote 无法标准化: ${remoteName}`);
  return repositoryKey;
};

export const prepareProjectConfiguration = ({ rootDir, projectConfig, defaults, repositories }) => {
  const repositoryKey = projectRepositoryKey(rootDir, projectConfig);
  const canonical = repositories[repositoryKey];
  if (!isObject(canonical)) fail(`全局仓库配置中找不到项目: ${repositoryKey}`);
  const next = clone(projectConfig);
  next.repositoryId ||= canonical.repositoryId;
  if (canonical.environments !== undefined) next.environments = clone(canonical.environments);
  if (defaults.releaseExecution !== undefined) next.releaseExecution = clone(defaults.releaseExecution);
  delete next.testDeployments;
  return { repositoryKey, config: next };
};

const migrateStepStages = (repositories, repositoryKeys = null) => {
  let count = 0;
  for (const [repositoryKey, repository] of Object.entries(repositories)) {
    if (repositoryKeys && !repositoryKeys.has(repositoryKey)) continue;
    for (const environment of Object.values(repository.environments ?? {})) {
      for (const step of environment.steps ?? []) {
        if (step.type !== 'pipeline') continue;
        const stage = normalizePipelineStage(step.stage);
        if (stage !== step.stage) {
          step.stage = stage;
          count += 1;
        }
      }
    }
  }
  return count;
};

export const migrateGlobalConfiguration = async ({
  defaults,
  repositories,
  resolver,
  resolveRepositoryIds = false,
  webhookStage = null,
  repositoryKeys = null,
}) => {
  const summary = {
    executionMigrated: repositoryKeys ? false : migrateExecution(defaults),
    stagesMigrated: migrateStepStages(repositories, repositoryKeys),
    repositoryIdsResolved: 0,
    webhooksMigrated: 0,
    duplicateWebhooksRemoved: 0,
    unresolved: [],
  };
  const organizationId = defaults.organizationId;
  if ((resolveRepositoryIds || webhookStage) && !organizationId) fail('全局默认配置缺少 organizationId');
  if (webhookStage && !pipelineStages.includes(webhookStage)) fail(`不支持的迁移阶段: ${webhookStage}`);

  for (const [repositoryKey, repository] of Object.entries(repositories)) {
    if (repositoryKeys && !repositoryKeys.has(repositoryKey)) continue;
    if (resolveRepositoryIds && !repository.repositoryId) {
      try {
        const remote = await resolver.getRepository(organizationId, repositoryKey);
        if (!remote?.id || normalizeRemoteUrl(remote.webUrl) !== repositoryKey) {
          fail(`返回仓库与 remote 不匹配`);
        }
        repository.repositoryId = String(remote.id);
        summary.repositoryIdsResolved += 1;
      } catch (error) {
        summary.unresolved.push(`${repositoryKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!webhookStage) continue;
    for (const [environmentName, environment] of Object.entries(repository.environments ?? {})) {
      const webhooks = (environment.steps ?? []).filter((step) => step.type === 'webhook');
      for (const webhook of webhooks) {
        const pipelineId = pipelineIdFromWebUrl(webhook.webUrl);
        if (!pipelineId) {
          summary.unresolved.push(`${repositoryKey}/${environmentName}: webhook 缺少可验证的 pipeline webUrl`);
          continue;
        }
        try {
          const pipeline = await resolver.getPipeline(organizationId, pipelineId);
          if (!pipeline?.name) fail('流水线不存在或缺少名称');
          const duplicate = environment.steps.find((step) => step.type === 'pipeline' && String(step.pipelineId) === pipelineId);
          environment.steps = environment.steps.filter((step) => step !== webhook);
          if (duplicate) {
            duplicate.stage = webhookStage;
            summary.duplicateWebhooksRemoved += 1;
          } else {
            environment.steps.push({
              type: 'pipeline',
              stage: webhookStage,
              pipelineName: pipeline.name,
              pipelineId,
              params: { envs: {} },
            });
            summary.webhooksMigrated += 1;
          }
        } catch (error) {
          summary.unresolved.push(`${repositoryKey}/${environmentName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }
  return summary;
};

const parseArgs = (argv) => {
  const args = { apply: false, resolveRepositoryIds: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply') args.apply = true;
    else if (key === '--resolve-repository-ids') args.resolveRepositoryIds = true;
    else {
      const value = argv[++index];
      if (!value) fail(`${key} 缺少参数值`);
      if (key === '--defaults') args.defaultsPath = resolve(value);
      else if (key === '--repositories') args.repositoriesPath = resolve(value);
      else if (key === '--project') args.projectRoot = realpathSync(resolve(value));
      else if (key === '--migrate-webhooks') args.webhookStage = value;
      else if (key === '--repository-key') args.repositoryKey = value;
      else fail(`未知参数: ${key}`);
    }
  }
  if (!args.defaultsPath || !args.repositoriesPath) fail('必须提供 --defaults 和 --repositories');
  return args;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const defaultsFile = readJson(args.defaultsPath);
  const repositoriesFile = readJson(args.repositoriesPath);
  if (args.projectRoot) {
    const projectPath = resolve(args.projectRoot, '.agents/yunxiao-release.json');
    const prepared = prepareProjectConfiguration({
      rootDir: args.projectRoot,
      projectConfig: readJson(projectPath),
      defaults: defaultsFile,
      repositories: repositoriesFile.repositories,
    });
    const resolver = args.resolveRepositoryIds || args.webhookStage ? await createYunxiaoResolver() : null;
    const summary = await migrateGlobalConfiguration({
      defaults: defaultsFile,
      repositories: { [prepared.repositoryKey]: prepared.config },
      resolver,
      resolveRepositoryIds: args.resolveRepositoryIds,
      webhookStage: args.webhookStage,
      repositoryKeys: new Set([prepared.repositoryKey]),
    });
    if (summary.unresolved.length) {
      console.error(JSON.stringify(summary, null, 2));
      process.exitCode = 2;
      return;
    }
    if (args.apply) writeJsonAtomic(projectPath, prepared.config);
    console.log(JSON.stringify({ applied: args.apply, project: prepared.repositoryKey, ...summary }, null, 2));
    return;
  }
  const resolver = args.resolveRepositoryIds || args.webhookStage ? await createYunxiaoResolver() : null;
  const summary = await migrateGlobalConfiguration({
    defaults: defaultsFile,
    repositories: repositoriesFile.repositories,
    resolver,
    resolveRepositoryIds: args.resolveRepositoryIds,
    webhookStage: args.webhookStage,
    repositoryKeys: args.repositoryKey ? new Set([args.repositoryKey]) : null,
  });
  if (summary.unresolved.length) {
    console.error(JSON.stringify(summary, null, 2));
    process.exitCode = 2;
    return;
  }
  if (args.apply) {
    writeJsonAtomic(args.defaultsPath, defaultsFile);
    writeJsonAtomic(args.repositoriesPath, repositoriesFile);
  }
  console.log(JSON.stringify({ applied: args.apply, ...summary }, null, 2));
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
