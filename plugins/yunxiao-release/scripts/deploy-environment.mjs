#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readUserMember } from './configure-member.mjs';
import { readProjectConfig } from './release-state.mjs';

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

// 所有 Git 参数独立传递，保留退出码和 stderr，禁止把仓库配置拼入 shell。
const runGit = (cwd, args, { allowFailure = false } = {}) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) fail(`Git 执行失败: ${result.error.message}`);
  if (result.status !== 0 && !allowFailure) {
    const detail = result.stderr.trim() || result.stdout.trim() || `退出码 ${result.status}`;
    fail(`git ${args[0]} 失败: ${detail}`);
  }
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
};

const validateBranch = (rootDir, branch, label) => {
  const result = runGit(rootDir, ['check-ref-format', '--branch', branch], { allowFailure: true });
  if (result.status !== 0) fail(`${label} 不是合法 Git 分支名: ${branch}`);
};

const validateRemote = (rootDir, remoteName) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(remoteName)) fail(`remoteName 无效: ${remoteName}`);
  const remotes = runGit(rootDir, ['remote']).stdout.split(/\r?\n/).filter(Boolean);
  if (!remotes.includes(remoteName)) fail(`Git remote 不存在: ${remoteName}`);
};

const getRemoteBranchSha = (rootDir, remoteName, branch) => {
  const ref = `refs/heads/${branch}`;
  const line = runGit(rootDir, ['ls-remote', '--heads', remoteName, ref]).stdout
    .split(/\r?\n/)
    .find((item) => item.endsWith(`\t${ref}`));
  if (!line) fail(`远端分支不存在: ${remoteName}/${branch}`);
  return line.split(/\s+/)[0];
};

const normalizeFeishuId = (value) => {
  const feishuId = value === undefined || value === null ? undefined : String(value).trim() || undefined;
  if (feishuId && /[\r\n\0]/.test(feishuId)) fail('feishuId 不能包含换行符');
  return feishuId;
};

// 项目本地值优先；缺失时回退到用户级 member.json，且不把 ID 写入执行结果或日志。
const resolveFeishuId = (rootDir, config, env) => {
  const localPath = resolve(rootDir, config.localConfigFile);
  if (existsSync(localPath)) {
    const realRelativePath = relative(rootDir, realpathSync(localPath));
    if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
      fail('localConfigFile 必须位于项目目录内');
    }
    const localConfig = readJson(localPath);
    if (localConfig.feishuId !== undefined) return normalizeFeishuId(localConfig.feishuId);
  }
  const userMember = readUserMember(env);
  return normalizeFeishuId(userMember?.feishuId);
};

// 手动环境只解析发布入口；自动环境额外验证仓库、当前分支和远端分支。
export const planEnvironmentDeployment = (rootArgument, environment, env = process.env) => {
  const rootDir = realpathSync(resolve(rootArgument));
  const config = readProjectConfig(rootDir);
  const deployment = config.testDeployments.find((item) => item.environment === environment);
  if (!deployment) fail(`未配置发布环境: ${environment}`);
  if (!deployment.targetBranch) return { mode: 'manual', environment, webUrl: deployment.webUrl };
  const repositoryRoot = resolve(runGit(rootDir, ['rev-parse', '--show-toplevel']).stdout);
  if (repositoryRoot !== rootDir) fail(`repo-root 必须是 Git 仓库根目录: ${repositoryRoot}`);
  if (runGit(rootDir, ['status', '--porcelain=v1', '--untracked-files=normal']).stdout) {
    fail('自动发布要求工作区干净');
  }
  const sourceBranch = runGit(rootDir, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { allowFailure: true }).stdout;
  if (!sourceBranch) fail('自动发布不支持 detached HEAD');
  validateRemote(rootDir, config.remoteName);
  [sourceBranch, config.targetBranch, deployment.targetBranch].forEach((branch) => validateBranch(rootDir, branch, '分支'));
  if (sourceBranch === config.targetBranch || sourceBranch === deployment.targetBranch) {
    fail('当前分支不能是 MR 目标分支或测试目标分支');
  }
  if (config.targetBranch === deployment.targetBranch) fail('MR 目标分支与测试目标分支不能相同');
  getRemoteBranchSha(rootDir, config.remoteName, config.targetBranch);
  getRemoteBranchSha(rootDir, config.remoteName, deployment.targetBranch);
  resolveFeishuId(rootDir, config, env);
  return {
    mode: 'automatic',
    environment,
    remoteName: config.remoteName,
    sourceBranch,
    releaseBranch: config.targetBranch,
    targetBranch: deployment.targetBranch,
    hookUrl: deployment.hookUrl,
    ...(deployment.webUrl ? { webUrl: deployment.webUrl } : {}),
  };
};

const fetchBranch = (rootDir, remoteName, branch) => {
  runGit(rootDir, [
    'fetch',
    remoteName,
    `+refs/heads/${branch}:refs/remotes/${remoteName}/${branch}`,
  ]);
};

const mergeRelease = (rootDir, remoteName, releaseBranch) => {
  try {
    runGit(rootDir, ['merge', '--no-edit', `refs/remotes/${remoteName}/${releaseBranch}`]);
  } catch (error) {
    runGit(rootDir, ['merge', '--abort'], { allowFailure: true });
    throw error;
  }
};

const cleanupWorktree = (rootDir, temporaryRoot, worktreePath, worktreeAdded) => {
  let cleanupError = null;
  if (worktreeAdded) {
    const removed = runGit(rootDir, ['worktree', 'remove', '--force', worktreePath], { allowFailure: true });
    if (removed.status !== 0) cleanupError = `临时 worktree 清理失败，请手动删除: ${worktreePath}`;
  }
  runGit(rootDir, ['worktree', 'prune'], { allowFailure: true });
  if (!cleanupError) rmSync(temporaryRoot, { recursive: true, force: true });
  return cleanupError;
};

const triggerWebhook = async (hookUrl, feishuId, branch, fetchImpl) => {
  const response = await fetchImpl(hookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...(feishuId ? { feishuId } : {}), branch }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`Webhook 返回 HTTP ${response.status}`);
};

// release 合入当前分支后，在隔离 worktree 更新测试分支；任何结果都尝试清理临时目录。
export const deployEnvironment = async (rootArgument, environment, options = {}) => {
  const rootDir = realpathSync(resolve(rootArgument));
  const env = options.env ?? process.env;
  const plan = planEnvironmentDeployment(rootDir, environment, env);
  if (plan.mode === 'manual') return plan;
  const config = readProjectConfig(rootDir);
  const deployment = config.testDeployments.find((item) => item.environment === environment);
  const feishuId = resolveFeishuId(rootDir, config, env);
  fetchBranch(rootDir, plan.remoteName, plan.releaseBranch);
  fetchBranch(rootDir, plan.remoteName, plan.targetBranch);
  mergeRelease(rootDir, plan.remoteName, plan.releaseBranch);
  const sourceCommit = runGit(rootDir, ['rev-parse', 'HEAD']).stdout;
  const temporaryRoot = mkdtempSync(resolve(tmpdir(), 'yunxiao-release-deploy-'));
  const worktreePath = resolve(temporaryRoot, 'worktree');
  let worktreeAdded = false;
  let operationError = null;
  let targetCommit;
  try {
    runGit(rootDir, ['worktree', 'add', '--detach', worktreePath, `refs/remotes/${plan.remoteName}/${plan.targetBranch}`]);
    worktreeAdded = true;
    runGit(worktreePath, ['merge', '--no-edit', sourceCommit]);
    targetCommit = runGit(worktreePath, ['rev-parse', 'HEAD']).stdout;
    runGit(worktreePath, ['push', plan.remoteName, `HEAD:refs/heads/${plan.targetBranch}`]);
    const remoteCommit = getRemoteBranchSha(rootDir, plan.remoteName, plan.targetBranch);
    if (remoteCommit !== targetCommit) fail(`远端 ${plan.targetBranch} 未更新到预期提交`);
    if (runGit(rootDir, ['merge-base', '--is-ancestor', sourceCommit, remoteCommit], { allowFailure: true }).status !== 0) {
      fail(`远端 ${plan.targetBranch} 未包含当前发布代码`);
    }
    try {
      await triggerWebhook(deployment.hookUrl, feishuId, plan.targetBranch, options.fetchImpl ?? fetch);
    } catch (error) {
      fail(`代码已推送，但构建未触发: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    operationError = error;
  }
  const cleanupError = cleanupWorktree(rootDir, temporaryRoot, worktreePath, worktreeAdded);
  if (operationError) {
    const message = operationError instanceof Error ? operationError.message : String(operationError);
    fail(`${message}${cleanupError ? `；${cleanupError}` : ''}`);
  }
  if (cleanupError) fail(cleanupError);
  return { ...plan, sourceCommit, targetCommit, webhookTriggered: true };
};

const printHelp = () => {
  console.log(`Usage:
  node deploy-environment.mjs --dry-run <repo-root> <environment>
  node deploy-environment.mjs <repo-root> <environment>`);
};

const main = async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return printHelp();
  const dryRun = args[0] === '--dry-run';
  const [rootDir, environment] = dryRun ? args.slice(1) : args;
  if (!rootDir || !environment || args.length !== (dryRun ? 3 : 2)) fail('参数无效，请使用 --help 查看用法');
  const result = dryRun
    ? planEnvironmentDeployment(rootDir, environment)
    : await deployEnvironment(rootDir, environment);
  console.log(JSON.stringify(result, null, 2));
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
