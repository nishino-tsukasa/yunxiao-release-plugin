#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planEnvironmentRelease } from '../environment-release-planner.mjs';
import {
  resolveReleaseConfiguration,
  resolveReleaseConfigurationForProject,
  resolveReleaseConfigurationForRepositoryKey,
} from '../release-configuration.mjs';
import { pipelineStages } from '../release-step-schema.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultOutput = resolve(scriptDir, 'output/changed-fat-flow-plan.json');

const parseArgs = (argv) => {
  const args = { environment: 'fat', output: defaultOutput, run: false, verbose: false, skipServer: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--run') args.run = true;
    else if (key === '--verbose') args.verbose = true;
    else if (key === '--skip-server') args.skipServer = true;
    else if (key === '--help' || key === '-h') args.help = true;
    else {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${key} 缺少参数值`);
      index += 1;
      const names = {
        '--environment': 'environment', '--projects': 'projects', '--client-projects': 'clientProjects',
        '--repository-keys': 'repositoryKeys', '--client-repository-keys': 'clientRepositoryKeys',
        '--repos': 'repos', '--client-repos': 'clientRepos',
        '--branch': 'branch', '--output': 'output', '--defaults-config': 'defaultsPath',
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
  可选：--environment、--defaults-config、--repositories-config、--skip-server、超时参数`);

const main = () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return printHelp();
  const identityModes = [args.projects, args.repositoryKeys, args.repos].filter(Boolean);
  if (identityModes.length !== 1 || !args.branch) {
    throw new Error('必须提供 --branch，并且只提供 --projects、--repository-keys 或 --repos 之一');
  }
  const identifiers = [...new Set((args.repos ?? args.repositoryKeys ?? args.projects).split(',').map((value) => value.trim()).filter(Boolean))].sort();
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
    stages: pipelineStages.map((name) => (
      configuredPipelineStages.find((stage) => stage.name === name) ?? { name, description: name, steps: [] }
    )),
    unresolved: [
      ...canonical.unresolved,
      ...configuredPipelineStages.flatMap(({ steps }) => steps.filter((step) => !step.readyToRun).map((step) => `项目 ${step.project} 的流水线 ${step.pipelineName ?? '<unknown>'} 缺少 pipelineId`)),
    ],
    execution: entries[0]?.profile.execution ?? {},
  };
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  writeFileSync(resolve(args.output), `${JSON.stringify(plan, null, 2)}\n`);
  if (!args.run) {
    console.log(`RESULT status=planned projects=${projects.join(',')} unresolved=${plan.unresolved.length} frontend_steps=${plan.stages[0].steps.length} client_steps=${plan.stages[1].steps.length} server_steps=${plan.stages[2].steps.length}`);
    return;
  }
  if (plan.unresolved.length) process.exit(3);
  const executorArgs = ['-u', resolve(scriptDir, 'plan_changed_fat_flow.py'), '--plan-input', resolve(args.output), '--run'];
  for (const [option, value] of [
    ['--poll-interval', args.pollInterval], ['--client-initial-wait', args.clientInitialWait],
    ['--client-timeout', args.clientTimeout], ['--server-timeout', args.serverTimeout],
  ]) if (value !== undefined) executorArgs.push(option, value);
  if (args.verbose) executorArgs.push('--verbose');
  const result = spawnSync('python3', executorArgs, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
};

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
