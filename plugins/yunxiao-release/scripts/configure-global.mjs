#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { readGlobalConfigFiles, resolveGlobalDefaultsPath, resolveGlobalRepositoriesPath } from './global-config.mjs';
import { readProjectConfig } from './release-state.mjs';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const writeJsonAtomic = (filePath, value) => {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
};

export const initializeGlobalConfig = (env = process.env) => {
  const defaultsPath = resolveGlobalDefaultsPath(env);
  const repositoriesPath = resolveGlobalRepositoriesPath(env);
  const current = readGlobalConfigFiles(env);
  if (!existsSync(defaultsPath)) writeJsonAtomic(defaultsPath, { schemaVersion: 1, ...current.defaults });
  if (!existsSync(repositoriesPath)) writeJsonAtomic(repositoriesPath, { schemaVersion: 1, repositories: current.repositories });
  return { defaultsPath, repositoriesPath };
};

export const applyGlobalConfig = (payload, env = process.env) => {
  if (!isObject(payload)) throw new Error('写入内容必须是 JSON 对象');
  const incomingDefaults = payload.defaults ?? {};
  const incomingRepositories = payload.repositories ?? {};
  if (!isObject(incomingDefaults) || !isObject(incomingRepositories)) throw new Error('defaults 和 repositories 必须是对象');
  if (Object.hasOwn(incomingDefaults, 'repositoryId')) throw new Error('全局默认配置不能包含 repositoryId');
  const current = readGlobalConfigFiles(env);
  const defaults = payload.mode === 'replace' ? incomingDefaults : { ...current.defaults, ...incomingDefaults };
  const keys = [...new Set([...Object.keys(current.repositories), ...Object.keys(incomingRepositories)])];
  const repositories = payload.mode === 'replace'
    ? incomingRepositories
    : Object.fromEntries(keys.map((key) => [key, { ...(current.repositories[key] ?? {}), ...(incomingRepositories[key] ?? {}) }]));
  Object.entries(repositories).forEach(([key, value]) => {
    if (!key || !isObject(value)) throw new Error(`仓库配置无效: ${key || '<empty>'}`);
  });
  writeJsonAtomic(resolveGlobalDefaultsPath(env), { schemaVersion: 1, ...defaults });
  writeJsonAtomic(resolveGlobalRepositoriesPath(env), { schemaVersion: 1, repositories });
  const projectConfigAction = payload.projectMigration
    ? finalizeProjectMigration(payload.projectMigration, env)
    : 'not-requested';
  return { defaultFieldCount: Object.keys(defaults).length, repositoryCount: Object.keys(repositories).length, projectConfigAction };
};

export const finalizeProjectMigration = (migration, env = process.env) => {
  if (!isObject(migration)) throw new Error('projectMigration 必须是对象');
  const rootDir = realpathSync(resolve(String(migration.rootDir || '')));
  const projectConfigPath = resolve(rootDir, '.agents/yunxiao-release.json');
  if (!existsSync(projectConfigPath)) return 'absent';
  const raw = JSON.parse(readFileSync(projectConfigPath, 'utf8'));
  const temporaryPath = `${projectConfigPath}.${randomUUID()}.migration`;
  renameSync(projectConfigPath, temporaryPath);
  let effective;
  try {
    effective = readProjectConfig(rootDir, env);
  } catch (error) {
    renameSync(temporaryPath, projectConfigPath);
    throw error;
  }
  const ignored = new Set(['reviewMode', 'tokenSource']);
  const mismatches = Object.entries(raw)
    .filter(([key]) => !ignored.has(key))
    .filter(([key, value]) => JSON.stringify(effective[key]) !== JSON.stringify(value))
    .map(([key]) => key);
  if (mismatches.length) {
    renameSync(temporaryPath, projectConfigPath);
    throw new Error(`集中配置未完整覆盖项目字段: ${mismatches.join(', ')}`);
  }
  const migrationAction = effective.projectConfigMigration;
  if (!['retain', 'delete'].includes(migrationAction)) {
    renameSync(temporaryPath, projectConfigPath);
    throw new Error('集中配置必须显式设置 projectConfigMigration=retain|delete');
  }
  if (migrationAction === 'retain') {
    renameSync(temporaryPath, projectConfigPath);
    return 'retained';
  }
  unlinkSync(temporaryPath);
  return 'deleted';
};

const readStdinJson = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString('utf8').trim();
  if (!content) throw new Error('缺少 stdin JSON');
  return JSON.parse(content);
};

const main = async () => {
  const command = process.argv[2] ?? '--init';
  if (command === '--check') {
    const config = readGlobalConfigFiles();
    console.log(JSON.stringify({ source: config.source, defaultFieldCount: Object.keys(config.defaults).length, repositoryCount: Object.keys(config.repositories).length }));
    return;
  }
  if (command === '--init') {
    const paths = initializeGlobalConfig();
    console.log(`全局配置已就绪：${paths.defaultsPath}, ${paths.repositoriesPath}`);
    return;
  }
  if (command === 'apply') {
    console.log(JSON.stringify(applyGlobalConfig(await readStdinJson())));
    return;
  }
  throw new Error('仅支持 --init、--check 或 apply');
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
