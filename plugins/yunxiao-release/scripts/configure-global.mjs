#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  assertGlobalDefaultScope,
  readGlobalConfigFiles,
  resolveGlobalDefaultsPath,
  resolveLegacyGlobalConfigPath,
  resolveGlobalRepositoriesPath,
} from './global-config.mjs';

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
  if (current.source === 'legacy') {
    try {
      assertGlobalDefaultScope(current.defaults);
    } catch {
      return { source: 'legacy', legacyPath: resolveLegacyGlobalConfigPath(env) };
    }
  }
  if (!existsSync(defaultsPath)) writeJsonAtomic(defaultsPath, { schemaVersion: 1, ...current.defaults });
  if (!existsSync(repositoriesPath)) writeJsonAtomic(repositoriesPath, { schemaVersion: 1, repositories: current.repositories });
  return { source: 'split', defaultsPath, repositoriesPath };
};

export const applyGlobalConfig = (payload, env = process.env) => {
  if (!isObject(payload)) throw new Error('写入内容必须是 JSON 对象');
  const incomingDefaults = payload.defaults ?? {};
  const incomingRepositories = payload.repositories ?? {};
  if (!isObject(incomingDefaults) || !isObject(incomingRepositories)) throw new Error('defaults 和 repositories 必须是对象');
  assertGlobalDefaultScope(incomingDefaults);
  const current = readGlobalConfigFiles(env);
  const defaults = payload.mode === 'replace' ? incomingDefaults : { ...current.defaults, ...incomingDefaults };
  assertGlobalDefaultScope(defaults);
  const keys = [...new Set([...Object.keys(current.repositories), ...Object.keys(incomingRepositories)])];
  const repositories = payload.mode === 'replace'
    ? incomingRepositories
    : Object.fromEntries(keys.map((key) => [key, { ...(current.repositories[key] ?? {}), ...(incomingRepositories[key] ?? {}) }]));
  Object.entries(repositories).forEach(([key, value]) => {
    if (!key || !isObject(value)) throw new Error(`仓库配置无效: ${key || '<empty>'}`);
  });
  writeJsonAtomic(resolveGlobalDefaultsPath(env), { schemaVersion: 1, ...defaults });
  writeJsonAtomic(resolveGlobalRepositoriesPath(env), { schemaVersion: 1, repositories });
  return { defaultFieldCount: Object.keys(defaults).length, repositoryCount: Object.keys(repositories).length };
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
    if (paths.source === 'legacy') console.log(`继续兼容旧全局配置：${paths.legacyPath}`);
    else console.log(`全局配置已就绪：${paths.defaultsPath}, ${paths.repositoriesPath}`);
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
