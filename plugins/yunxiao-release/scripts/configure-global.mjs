#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGlobalDefaultsPath, resolveGlobalRepositoriesPath } from './global-config.mjs';

export const initializeGlobalConfig = (env = process.env) => {
  const targets = [resolveGlobalDefaultsPath(env), resolveGlobalRepositoriesPath(env)];
  const templates = [
    resolve(dirname(fileURLToPath(import.meta.url)), '../config/global-defaults.json'),
    resolve(dirname(fileURLToPath(import.meta.url)), '../config/global-repositories.json'),
  ];
  mkdirSync(dirname(targets[0]), { recursive: true, mode: 0o700 });
  targets.forEach((filePath, index) => {
    if (existsSync(filePath)) return;
    const temporaryPath = `${filePath}.tmp`;
    writeFileSync(temporaryPath, readFileSync(templates[index], 'utf8'), { mode: 0o600 });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  });
  return targets;
};

const main = () => {
  const filePaths = [resolveGlobalDefaultsPath(), resolveGlobalRepositoriesPath()];
  if (process.argv.includes('--check')) {
    if (filePaths.some((filePath) => !existsSync(filePath))) throw new Error(`全局配置不完整：${filePaths.join(', ')}`);
    const repositories = JSON.parse(readFileSync(filePaths[1], 'utf8'));
    console.log(JSON.stringify({ filePaths, repositoryCount: Object.keys(repositories.repositories ?? {}).length }));
    return;
  }
  if (process.argv.length > 2 && !process.argv.includes('--init')) throw new Error('仅支持 --init 或 --check');
  console.log(`全局配置已就绪：${initializeGlobalConfig().join(', ')}`);
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
