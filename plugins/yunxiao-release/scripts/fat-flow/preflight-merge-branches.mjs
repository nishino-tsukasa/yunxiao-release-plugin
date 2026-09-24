#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { resolveReleaseConfiguration } from '../release-configuration.mjs';

const [repoArg, sourceBranch, environmentName = 'fat'] = process.argv.slice(2);
if (!repoArg || !sourceBranch) throw new Error('用法: preflight-merge-branches.mjs <repo> <source-branch> [environment]');
const repo = resolve(repoArg);
const profile = resolveReleaseConfiguration(repo);
const environment = profile.environments[environmentName];
if (!environment) throw new Error(`项目 ${profile.project} 未配置环境 ${environmentName}`);
const remote = profile.repository.remoteName;

const git = (...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args[0]} 失败: ${(result.stdout + result.stderr).trim().slice(-1200)}`);
  return result.stdout.trim();
};
const assertBranch = (branch) => git('check-ref-format', '--branch', branch);
const fetchBranch = (branch) => {
  assertBranch(branch);
  git('fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`);
  return `refs/remotes/${remote}/${branch}`;
};
const previewMerge = (left, right, label) => {
  const result = spawnSync('git', ['merge-tree', '--write-tree', '--messages', left, right], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) {
    const details = (result.stdout + result.stderr).split('\n').filter((line) => /CONFLICT|冲突|error:|fatal:/i.test(line)).join('; ');
    throw new Error(`${label} 预合并冲突: ${details || 'git merge-tree failed'}`);
  }
  return result.stdout.split('\n')[0].trim();
};

try {
  const branches = environment.preflightMergeBranches ?? [];
  if (!branches.length) {
    console.log(`RESULT status=skipped project=${profile.project} preflight_branches=none`);
  } else {
    assertBranch(sourceBranch);
    const source = git('rev-parse', '--verify', `refs/heads/${sourceBranch}`);
    const remoteSource = spawnSync('git', ['ls-remote', '--heads', remote, sourceBranch], { cwd: repo, encoding: 'utf8' });
    if (remoteSource.status !== 0) throw new Error(`无法查询远端源分支 ${remote}/${sourceBranch}`);
    if (remoteSource.stdout.trim()) {
      const sourceRef = fetchBranch(sourceBranch);
      const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', sourceRef, source], { cwd: repo });
      if (ancestor.status !== 0) throw new Error(`远端源分支未包含在本地 ${sourceBranch} 中，请先同步后再预检`);
    }
    const targetBranch = environment.branch;
    if (!targetBranch) throw new Error(`环境 ${environmentName} 缺少目标分支`);
    const targetRef = fetchBranch(targetBranch);
    const targetTree = previewMerge(targetRef, source, `${targetBranch} <- ${sourceBranch}`);
    const synthetic = git(
      '-c', 'user.name=Yunxiao Preflight', '-c', 'user.email=preflight@example.invalid',
      'commit-tree', targetTree, '-p', targetRef, '-p', source, '-m', 'preflight merge',
    );
    for (const branch of branches) {
      if (branch === targetBranch) throw new Error(`预检目标分支不能与环境目标分支相同: ${branch}`);
      previewMerge(fetchBranch(branch), synthetic, `${branch} <- ${targetBranch}`);
    }
    console.log(`RESULT status=success project=${profile.project} preflight_branches=${branches.join(',')}`);
  }
} catch (error) {
  console.error(`FAIL status=failed project=${profile.project} message=${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
