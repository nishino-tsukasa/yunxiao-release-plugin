#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveGlobalConfigPath } from './global-config.mjs';

export const initializeGlobalConfig = (env = process.env) => {
  const filePath = resolveGlobalConfigPath(env);
  if (existsSync(filePath)) return filePath;
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify({ schemaVersion: 1, defaults: {}, repositories: {} }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
  chmodSync(filePath, 0o600);
  return filePath;
};

const main = () => {
  const filePath = resolveGlobalConfigPath();
  if (process.argv.includes('--check')) {
    if (!existsSync(filePath)) throw new Error(`全局项目配置不存在：${filePath}`);
    const config = JSON.parse(readFileSync(filePath, 'utf8'));
    console.log(JSON.stringify({ filePath, schemaVersion: config.schemaVersion, repositoryCount: Object.keys(config.repositories ?? {}).length }));
    return;
  }
  if (process.argv.length > 2 && !process.argv.includes('--init')) throw new Error('仅支持 --init 或 --check');
  console.log(`全局项目配置已就绪：${initializeGlobalConfig()}`);
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
