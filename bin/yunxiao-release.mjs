#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scriptsDir = resolve(repositoryRoot, 'plugins/yunxiao-release/scripts');

const printHelp = () => {
  console.log(`Usage:
  yunxiao-release                 交互安装
  yunxiao-release configure       初始化或更新项目配置
  yunxiao-release global [--init|--check|apply] 初始化、检查或写入全局项目配置
  yunxiao-release migrate-global <args> 迁移并核实拆分全局配置
  yunxiao-release token [--check] 配置或检查全局 Token
  yunxiao-release fat-flow <args> 执行多仓库 FAT 环境发布`);
};

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: process.cwd(), stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
};

// 公开 CLI 只路由到已有安装和配置脚本，保持唯一实现来源。
const main = () => {
  const [command = 'install', ...args] = process.argv.slice(2);
  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }
  if (command === 'install') {
    if (args.length) throw new Error('install 不接受参数');
    run('bash', [resolve(repositoryRoot, 'install.sh')]);
    return;
  }
  if (command === 'configure') {
    if (args.length) throw new Error('configure 不接受参数');
    run(process.execPath, [resolve(scriptsDir, 'configure-project.mjs')]);
    return;
  }
  if (command === 'token') {
    run(process.execPath, [resolve(scriptsDir, 'configure-token.mjs'), ...args]);
    return;
  }
  if (command === 'global') {
    run(process.execPath, [resolve(scriptsDir, 'configure-global.mjs'), ...args]);
    return;
  }
  if (command === 'migrate-global') {
    run(process.execPath, [resolve(scriptsDir, 'migrate-global-config.mjs'), ...args]);
    return;
  }
  if (command === 'fat-flow') {
    run('bash', [resolve(scriptsDir, 'fat-flow/run-full-fat-flow-deploy.sh'), ...args]);
    return;
  }
  throw new Error(`未知命令: ${command}`);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
