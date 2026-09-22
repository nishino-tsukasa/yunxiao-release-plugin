#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeMember, readUserMember, resolveUserMemberPath } from './configure-member.mjs';
import { readGlobalProjectConfig } from './global-config.mjs';

const requiredConfigKeys = ['organizationId', 'repositoryId'];
const projectConfigPath = '.agents/yunxiao-release.json';
const legacyProjectConfigPath = '.codex/yunxiao-release.json';
const configDefaults = {
  remoteName: 'origin',
  targetBranch: 'master',
  versionFile: 'package.json',
  announcementFile: null,
  localConfigFile: '.agents/yunxiao-release.local.json',
  runtimeFile: '.agents/runtime/yunxiao-release-mr.json',
  commentsFile: '.agents/runtime/yunxiao-release-comments.md',
  validationCommands: ['git diff --check'],
  testDeployments: [],
};
const requiredRecordKeys = [
  'mrId',
  'title',
  'url',
  'createdAt',
  'createdBy',
  'sourceBranch',
  'targetBranch',
  'lastSyncedAt',
];

const fail = (message) => {
  throw new Error(message);
};

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`无法读取 JSON ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const ensureKeys = (value, keys, label) => {
  const missing = keys.filter((key) => value[key] === undefined || value[key] === '');
  if (missing.length > 0) {
    fail(`${label} 缺少字段: ${missing.join(', ')}`);
  }
};

const withoutMissingValues = (value) => Object.fromEntries(
  Object.entries(value).filter(([, item]) => item !== undefined && item !== ''),
);

const resolveProjectPath = (rootDir, configuredPath, label) => {
  if (typeof configuredPath !== 'string' || !configuredPath || isAbsolute(configuredPath)) {
    fail(`${label} 必须是项目内相对路径`);
  }
  const filePath = resolve(rootDir, configuredPath);
  const relativePath = relative(resolve(rootDir), filePath);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    fail(`${label} 必须位于项目目录内`);
  }
  return filePath;
};

const normalizeHttpUrl = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} 必须是非空 HTTP(S) URL`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} 必须是有效 HTTP(S) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) fail(`${label} 只允许 HTTP(S) URL`);
  return url.toString();
};

// 自动环境必须同时提供目标分支和 webhook；手动环境只提供可点击的发布入口。
const normalizeTestDeployments = (deployments) => {
  if (!Array.isArray(deployments)) fail('testDeployments 必须是数组');
  const environments = new Set();
  return deployments.map((deployment, index) => {
    if (!deployment || typeof deployment !== 'object' || Array.isArray(deployment)) {
      fail(`testDeployments[${index}] 必须是对象`);
    }
    const environment = typeof deployment.environment === 'string' ? deployment.environment.trim() : '';
    if (!environment || /[\r\n\0]/.test(environment)) fail(`testDeployments[${index}].environment 无效`);
    if (environments.has(environment)) fail(`testDeployments environment 重复: ${environment}`);
    environments.add(environment);
    const hasTargetBranch = deployment.targetBranch !== undefined && deployment.targetBranch !== null;
    const hasHookUrl = deployment.hookUrl !== undefined && deployment.hookUrl !== null;
    if (hasTargetBranch !== hasHookUrl) fail(`${environment} 的 targetBranch 和 hookUrl 必须同时配置`);
    const webUrl = deployment.webUrl === undefined || deployment.webUrl === null
      ? undefined
      : normalizeHttpUrl(deployment.webUrl, `${environment}.webUrl`);
    if (!hasTargetBranch && !webUrl) fail(`${environment} 手动发布环境必须配置 webUrl`);
    if (!hasTargetBranch) return { environment, webUrl };
    const targetBranch = typeof deployment.targetBranch === 'string' ? deployment.targetBranch.trim() : '';
    if (!targetBranch || /[\r\n\0]/.test(targetBranch)) fail(`${environment}.targetBranch 无效`);
    return {
      environment,
      targetBranch,
      hookUrl: normalizeHttpUrl(deployment.hookUrl, `${environment}.hookUrl`),
      ...(webUrl ? { webUrl } : {}),
    };
  });
};

// 兼容最小社区配置，并在读取时补齐不会改变云端状态的默认值。
export const readProjectConfig = (rootDir, env = process.env) => {
  const configPath = resolve(rootDir, projectConfigPath);
  const legacyConfigPath = resolve(rootDir, legacyProjectConfigPath);
  if (existsSync(configPath) && existsSync(legacyConfigPath)) fail('新旧项目共享配置同时存在，请确认保留哪一份');
  const sourcePath = existsSync(configPath) ? configPath : legacyConfigPath;
  const projectConfig = existsSync(sourcePath) ? readJson(sourcePath) : {};
  const initialGlobal = readGlobalProjectConfig(rootDir, env, projectConfig.remoteName || 'origin');
  const remoteName = projectConfig.remoteName || initialGlobal.config.remoteName || 'origin';
  const globalConfig = remoteName === (projectConfig.remoteName || 'origin')
    ? initialGlobal.config
    : readGlobalProjectConfig(rootDir, env, remoteName).config;
  const rawConfig = { ...globalConfig, ...withoutMissingValues(projectConfig) };
  ensureKeys(rawConfig, requiredConfigKeys, '合并后的项目配置');
  const { reviewMode: _reviewMode, ...currentConfig } = rawConfig;
  const config = { ...configDefaults, ...currentConfig };
  const releaseFrontendGroups = new Set(['saas', 'cms', 'starlink', 'enterprise']);
  const policyProjectType = globalConfig.projectType || projectConfig.projectType;
  const policyProjectGroup = globalConfig.projectGroup || projectConfig.projectGroup;
  const requiresRelease = policyProjectType === 'backend'
    || (policyProjectType === 'frontend' && releaseFrontendGroups.has(policyProjectGroup));
  if (requiresRelease && config.targetBranch !== 'release') {
    fail('当前项目的 MR targetBranch 必须是 release');
  }
  if (!Array.isArray(config.validationCommands) || config.validationCommands.length === 0) {
    fail('validationCommands 必须是非空数组');
  }
  ['localConfigFile', 'runtimeFile', 'commentsFile', 'versionFile', 'announcementFile']
    .filter((key) => config[key] !== null)
    .forEach((key) => resolveProjectPath(rootDir, config[key], key));
  return { ...config, testDeployments: normalizeTestDeployments(config.testDeployments) };
};

const writeJsonAtomic = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
};

const getState = (rootDir, config) => {
  const statePath = resolveProjectPath(rootDir, config.runtimeFile, 'runtimeFile');
  const emptyState = {
    schemaVersion: 1,
    organizationId: config.organizationId,
    repositoryId: config.repositoryId,
    branches: {},
  };
  const state = existsSync(statePath) ? readJson(statePath) : emptyState;
  if (state.organizationId !== config.organizationId || state.repositoryId !== config.repositoryId) {
    fail('MR 运行状态与项目共享配置不匹配');
  }
  if (state.schemaVersion !== 1 || typeof state.branches !== 'object' || state.branches === null) {
    fail('MR 运行状态格式无效');
  }
  return { state, statePath };
};

const normalizeRecord = (record) => {
  ensureKeys(record, requiredRecordKeys, 'MR 记录');
  if (Number.isNaN(Date.parse(record.createdAt)) || Number.isNaN(Date.parse(record.lastSyncedAt))) {
    fail('MR createdAt 和 lastSyncedAt 必须是有效时间');
  }
  const { reviewMode: _reviewMode, ...normalizedRecord } = record;
  return {
    ...normalizedRecord,
    mrId: String(normalizedRecord.mrId),
    mergeStatus: normalizedRecord.mergeStatus ?? 'opened',
    mergedAt: normalizedRecord.mergedAt ?? null,
    mergeCommit: normalizedRecord.mergeCommit ?? null,
  };
};

// 同一 MR 按 mrId 原位更新，其他 MR 按创建时间排序，保证重复执行不会追加重复记录。
export const upsertMr = (rootDir, rawRecord) => {
  const config = readProjectConfig(rootDir);
  const record = normalizeRecord(rawRecord);
  if (record.targetBranch !== config.targetBranch) {
    fail(`MR 目标分支必须是 ${config.targetBranch}，当前为 ${record.targetBranch}`);
  }
  const { state, statePath } = getState(rootDir, config);
  const branchRecords = state.branches[record.sourceBranch] ?? [];
  const existingIndex = branchRecords.findIndex(({ mrId }) => String(mrId) === record.mrId);
  const nextRecords =
    existingIndex < 0
      ? [...branchRecords, record]
      : branchRecords.map((item, index) => (index === existingIndex ? normalizeRecord({ ...item, ...record }) : item));
  const nextState = {
    ...state,
    branches: {
      ...state.branches,
      [record.sourceBranch]: nextRecords.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
    },
  };
  writeJsonAtomic(statePath, nextState);
  return record;
};

export const getCurrentMr = (rootDir, sourceBranch) => {
  const config = readProjectConfig(rootDir);
  const { state } = getState(rootDir, config);
  const records = state.branches[sourceBranch] ?? [];
  if (records.length === 0) {
    fail(`当前分支没有 MR 记录: ${sourceBranch}`);
  }
  return normalizeRecord(records.toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0]);
};

// 项目配置覆盖用户级配置，既支持项目隔离，也让新 worktree 自动复用成员身份。
export const checkConfig = (rootDir, env = process.env) => {
  const config = readProjectConfig(rootDir, env);
  const localConfigPath = resolveProjectPath(rootDir, config.localConfigFile, 'localConfigFile');
  if (existsSync(localConfigPath)) {
    const localConfig = normalizeMember(readJson(localConfigPath));
    return {
      config,
      localConfig,
      memberConfigSource: 'project',
    };
  }
  const localConfig = readUserMember(env);
  if (!localConfig) fail(`缺少成员配置: ${localConfigPath} 或 ${resolveUserMemberPath(env)}`);
  const memberConfigSource = existsSync(resolveUserMemberPath(env)) ? 'user' : 'legacy-codex-home';
  return { config, localConfig, memberConfigSource };
};

const printHelp = () => {
  console.log(`Usage:
  node release-state.mjs check <repo-root>
  node release-state.mjs upsert <repo-root> <record-json-file>
  node release-state.mjs current <repo-root> <source-branch>`);
};

// CLI 只操作本地 JSON；云效读取和写入始终由插件声明的官方 MCP 完成。
const main = () => {
  const [command, rootArgument = '.', value] = process.argv.slice(2);
  const rootDir = resolve(rootArgument);
  if (!command || command === '--help') {
    printHelp();
    return;
  }
  if (command === 'check') {
    console.log(JSON.stringify(checkConfig(rootDir), null, 2));
    return;
  }
  if (command === 'upsert') {
    if (!value) {
      fail('upsert 需要 MR record JSON 文件');
    }
    console.log(JSON.stringify(upsertMr(rootDir, readJson(resolve(value))), null, 2));
    return;
  }
  if (command === 'current') {
    if (!value) {
      fail('current 需要 source branch');
    }
    console.log(JSON.stringify(getCurrentMr(rootDir, value), null, 2));
    return;
  }
  fail(`未知命令: ${command}`);
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
