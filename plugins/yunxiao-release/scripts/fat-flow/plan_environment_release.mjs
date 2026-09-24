#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planEnvironmentRelease } from '../environment-release-planner.mjs';
import {
  resolveReleaseConfiguration,
  resolveReleaseConfigurationForProject,
  resolveReleaseConfigurationForRepositoryKey,
} from '../release-configuration.mjs';
import { pipelineStages } from '../release-step-schema.mjs';
import { planDependencyWaves } from './dependency-waves.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultOutput = resolve(scriptDir, 'output/changed-fat-flow-plan.json');

const parseArgs = (argv) => {
  const args = { environment: 'fat', output: defaultOutput, dependsOn: [], preflightMergeBranches: [], run: false, validate: false, verbose: false, skipServer: false, resume: false, retryFailed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--run') args.run = true;
    else if (key === '--validate') args.validate = true;
    else if (key === '--resume') args.resume = true;
    else if (key === '--retry-failed') args.retryFailed = true;
    else if (key === '--verbose') args.verbose = true;
    else if (key === '--skip-server') args.skipServer = true;
    else if (key === '--help' || key === '-h') args.help = true;
    else {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${key} 缺少参数值`);
      index += 1;
      if (key === '--depends-on') {
        args.dependsOn.push(value);
        continue;
      }
      if (key === '--preflight-merge-branch') {
        args.preflightMergeBranches.push(value);
        continue;
      }
      const names = {
        '--environment': 'environment', '--projects': 'projects', '--client-projects': 'clientProjects',
        '--repository-keys': 'repositoryKeys', '--client-repository-keys': 'clientRepositoryKeys',
        '--repos': 'repos', '--client-repos': 'clientRepos',
        '--branch': 'branch', '--output': 'output', '--defaults-config': 'defaultsPath',
        '--state-file': 'stateFile',
        '--repositories-config': 'repositoriesPath', '--poll-interval': 'pollInterval',
        '--client-initial-wait': 'clientInitialWait', '--client-timeout': 'clientTimeout',
        '--server-timeout': 'serverTimeout',
      };
      if (!names[key]) throw new Error(`未知参数: ${key}`);
      args[names[key]] = value;
    }
  }
  return args;
};

const printHelp = () => console.log(`Usage:
  plan-environment-release --projects <a,b> --branch <source> [--client-projects <a,b>] [--run]
  plan-environment-release --repository-keys <host/group/repo,...> --branch <source> [--client-repository-keys <...>] [--run]
  plan-environment-release --repos <path,...> --branch <source> [--client-repos <path,...>] [--run]
  可选：--depends-on <consumer:provider>、--preflight-merge-branch <project:branch>（均可重复指定）、--environment、--defaults-config、--repositories-config、--skip-server、超时参数
  失败后：重复相同仓库和分支参数，并添加 --resume --state-file <上次输出路径> [--retry-failed]`);

const remoteRevision = (repo, remote, branch) => {
  const result = spawnSync('git', ['ls-remote', '--heads', remote, branch], { cwd: repo, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`无法核对远端分支 ${repo} ${remote}/${branch}: ${result.stderr.trim()}`);
  const [sha, ref] = result.stdout.trim().split(/\s+/);
  if (!sha || ref !== `refs/heads/${branch}`) throw new Error(`远端分支不存在: ${repo} ${remote}/${branch}`);
  return sha;
};

const verifyRevisions = (plan) => {
  for (const revision of plan.revisions ?? []) {
    const current = remoteRevision(revision.repo, revision.remote, revision.branch);
    if (current !== revision.sha) throw new Error(`发布后远端分支已变化，拒绝续跑: ${revision.repo} ${revision.branch}`);
  }
};

const execute = (args, planPath, stateFile) => {
  const executorArgs = ['-u', resolve(scriptDir, 'plan_changed_fat_flow.py'), '--plan-input', planPath, '--run', '--state-file', stateFile];
  for (const [option, value] of [
    ['--poll-interval', args.pollInterval], ['--client-initial-wait', args.clientInitialWait],
    ['--client-timeout', args.clientTimeout], ['--server-timeout', args.serverTimeout],
  ]) if (value !== undefined) executorArgs.push(option, value);
  if (args.verbose) executorArgs.push('--verbose');
  if (args.resume) executorArgs.push('--resume');
  if (args.retryFailed) executorArgs.push('--retry-failed');
  const result = spawnSync('python3', executorArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
};

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const identityModes = [args.projects, args.repositoryKeys, args.repos].filter(Boolean);
  if (identityModes.length !== 1 || !args.branch) {
    throw new Error('必须提供 --branch，并且只提供 --projects、--repository-keys 或 --repos 之一');
  }
  const identifiers = [...new Set((args.repos ?? args.repositoryKeys ?? args.projects).split(',').map((value) => value.trim()).filter(Boolean))].sort();
  const mode = args.repos ? 'repos' : (args.repositoryKeys ? 'repositoryKeys' : 'projects');
  const dependencies = args.dependsOn.map((value) => {
    const parts = value.split(':').map((part) => part.trim());
    if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`--depends-on 格式必须是 <consumer:provider>: ${value}`);
    return { consumer: parts[0], provider: parts[1] };
  }).sort((left, right) => `${left.consumer}:${left.provider}`.localeCompare(`${right.consumer}:${right.provider}`));
  const preflightMergeBranches = args.preflightMergeBranches.map((value) => {
    const parts = value.split(':').map((part) => part.trim());
    if (parts.length !== 2 || parts.some((part) => !part)) throw new Error(`--preflight-merge-branch 格式必须是 <project:branch>: ${value}`);
    return { project: parts[0], branch: parts[1] };
  }).sort((left, right) => `${left.project}:${left.branch}`.localeCompare(`${right.project}:${right.branch}`));
  if (new Set(preflightMergeBranches.map(({ project, branch }) => `${project}\0${branch}`)).size !== preflightMergeBranches.length) {
    throw new Error('本次发布预合并分支重复');
  }
  if (preflightMergeBranches.length && !args.repos) throw new Error('--preflight-merge-branch 需要 --repos 才能检查本地 Git 分支');
  const request = { mode, identifiers, sourceBranch: args.branch, environment: args.environment, dependencies, preflightMergeBranches };
  if (args.retryFailed && !args.resume) throw new Error('--retry-failed 只能与 --resume 一起使用');
  if (args.resume) {
    if (!args.run || !args.stateFile) throw new Error('--resume 需要 --run 和 --state-file');
    const frozenPath = `${resolve(args.stateFile)}.plan.json`;
    const frozen = JSON.parse(readFileSync(frozenPath, 'utf8'));
    if (JSON.stringify(frozen.request) !== JSON.stringify(request)) {
      throw new Error('续跑输入与原发布计划不一致');
    }
    verifyRevisions(frozen);
    execute(args, frozenPath, resolve(args.stateFile));
    return;
  }
  const clientProjects = args.clientProjects === undefined
    ? null
    : new Set(args.clientProjects.split(',').map((value) => value.trim()).filter(Boolean));
  const clientRepositoryKeys = args.clientRepositoryKeys === undefined
    ? null
    : new Set(args.clientRepositoryKeys.split(',').map((value) => value.trim()).filter(Boolean));
  const clientRepos = args.clientRepos === undefined
    ? null
    : new Set(args.clientRepos.split(',').map((value) => value.trim()).filter(Boolean));
  const files = { defaultsPath: args.defaultsPath, repositoriesPath: args.repositoriesPath };
  const entries = identifiers.map((identifier) => {
    const profile = args.repos
      ? resolveReleaseConfiguration(resolve(identifier), process.env)
      : (args.repositoryKeys
        ? resolveReleaseConfigurationForRepositoryKey(identifier, process.env, files)
        : resolveReleaseConfigurationForProject(identifier, process.env, files));
    return {
      profile,
      sourceBranch: args.branch,
      changedFiles: [],
      includeClient: args.repos
        ? (clientRepos === null ? true : clientRepos.has(identifier))
        : (args.repositoryKeys
          ? (clientRepositoryKeys === null ? true : clientRepositoryKeys.has(identifier))
          : (clientProjects === null ? true : clientProjects.has(identifier))),
      includeServer: !args.skipServer,
    };
  });
  const projects = entries.map(({ profile }) => profile.project);
  for (const { project } of preflightMergeBranches) {
    if (!projects.includes(project)) throw new Error(`本次发布预合并分支必须引用已选项目: ${project}`);
  }
  const executionVariants = new Set(entries.map(({ profile }) => JSON.stringify(profile.execution)));
  if (executionVariants.size > 1) {
    throw new Error('同一次多仓发布的 releaseExecution 必须完全一致');
  }
  const canonical = planEnvironmentRelease({
    environment: args.environment,
    repositories: entries,
    allowedStepTypes: ['pipeline'],
  });
  const branches = [...new Set(entries.map(({ profile }) => profile.environments[args.environment]?.branch).filter(Boolean))];
  const configuredPipelineStages = canonical.stages
    .filter(({ name }) => pipelineStages.includes(name))
    .map(({ name, steps }) => ({
      name,
      description: name,
      steps: steps.map((step) => ({ ...step, readyToRun: Boolean(step.pipelineId) })),
    }));
  const plan = {
    generatedAt: new Date().toISOString(),
    environment: args.environment,
    branch: branches.length === 1 ? branches[0] : 'mixed',
    changedProjects: projects,
    request,
    dependencies,
    preflightMergeBranches,
    stages: pipelineStages.map((name) => (
      configuredPipelineStages.find((stage) => stage.name === name) ?? { name, description: name, steps: [] }
    )),
    unresolved: [
      ...canonical.unresolved,
      ...configuredPipelineStages.flatMap(({ steps }) => steps.filter((step) => !step.readyToRun).map((step) => `项目 ${step.project} 的流水线 ${step.pipelineName ?? '<unknown>'} 缺少 pipelineId`)),
    ],
    execution: entries[0]?.profile.execution ?? {},
  };
  const dependencyWaves = planDependencyWaves(entries, dependencies);
  plan.waves = dependencyWaves.map((waveProjects) => ({
    projects: waveProjects,
    stages: plan.stages.map((stage) => ({
      ...stage,
      steps: stage.steps.filter((step) => waveProjects.includes(step.project)),
    })),
  }));
  if (args.run && args.repos) {
    for (const { repo, profile } of identifiers.map((repo, index) => ({ repo, profile: entries[index].profile }))) {
      const branchesToCheck = preflightMergeBranches.filter(({ project }) => project === profile.project).map(({ branch }) => branch);
      if (!branchesToCheck.length) continue;
      const result = spawnSync('node', [resolve(scriptDir, 'preflight-merge-branches.mjs'), repo, args.branch, args.environment, ...branchesToCheck], {
        encoding: 'utf8', stdio: 'inherit',
      });
      if (result.status !== 0) throw new Error(`本次构建分支预合并检查失败: ${profile.project}`);
    }
    plan.revisions = identifiers.map((repo, index) => {
      const profile = entries[index].profile;
      const branch = profile.environments[args.environment]?.branch;
      if (!branch) throw new Error(`项目 ${profile.project} 缺少环境目标分支`);
      return { repo, remote: profile.repository.remoteName, branch, sha: remoteRevision(repo, profile.repository.remoteName, branch) };
    });
  }
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(resolve(args.output), `${JSON.stringify(plan, null, 2)}\n`);
  if (!args.run) {
    console.log(`RESULT status=planned projects=${projects.join(',')} unresolved=${plan.unresolved.length} frontend_steps=${plan.stages[0].steps.length} client_steps=${plan.stages[1].steps.length} server_steps=${plan.stages[2].steps.length}`);
    if (args.validate && plan.unresolved.length) process.exitCode = 3;
    return;
  }
  if (plan.unresolved.length) process.exit(3);
  const stateDir = resolve(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'yunxiao-release/fat-flow');
  const stateFile = resolve(args.stateFile || join(stateDir, `${Date.now()}-${randomUUID()}.json`));
  mkdirSync(dirname(stateFile), { recursive: true, mode: 0o700 });
  const frozenPath = `${stateFile}.plan.json`;
  writeFileSync(frozenPath, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`PROGRESS resume_state=${stateFile}`);
  execute(args, frozenPath, stateFile);
};

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
