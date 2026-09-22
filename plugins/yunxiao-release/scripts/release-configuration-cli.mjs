#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import {
  resolveReleaseConfiguration,
  resolveReleaseConfigurationForProject,
} from './release-configuration.mjs';

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 2) options[rest[index]] = rest[index + 1];
  return { command, options };
};

const readProfile = (options) => {
  if (options['--repo']) return resolveReleaseConfiguration(resolve(options['--repo']));
  if (options['--project']) return resolveReleaseConfigurationForProject(options['--project']);
  throw new Error('必须提供 --repo 或 --project');
};

const readField = (profile, field, environment) => {
  let value = field === 'environment' ? profile.environments[environment] : profile;
  const path = field === 'environment' ? [] : field.split('.');
  for (const part of path) {
    if (!part || !value || typeof value !== 'object' || !(part in value)) throw new Error(`配置缺少字段: ${field}`);
    value = value[part];
  }
  return value;
};

const hasClientStage = (profile, environment) => profile.environments[environment]?.steps.some(
  (step) => step.type === 'pipeline' && step.stage === 'client-package',
);

const needsClient = (profile, repo, branch, environment) => {
  const step = profile.environments[environment]?.steps.find(
    (candidate) => candidate.type === 'pipeline' && candidate.stage === 'client-package',
  );
  if (!step) return false;
  if (!step.when?.changedPaths) return true;
  const target = profile.environments[environment].branch;
  const base = `refs/remotes/${profile.repository.remoteName}/${target}`;
  const exists = spawnSync('git', ['rev-parse', '--verify', '--quiet', base], { cwd: repo });
  if (exists.status !== 0) throw new Error(`无法确定 Client 改动基准: ${base}`);
  const changed = spawnSync('git', ['diff', '--name-only', `${base}...${branch}`], { cwd: repo, encoding: 'utf8' });
  if (changed.status !== 0) throw new Error(`无法读取 Client 改动: ${repo}`);
  return changed.stdout.split(/\r?\n/).some((path) => step.when.changedPaths.some((prefix) => path.startsWith(prefix)));
};

const main = () => {
  const { command, options } = parseArgs(process.argv.slice(2));
  const profile = readProfile(options);
  const environment = options['--environment'] || 'fat';
  if (command === 'get') {
    const field = options['--field'];
    if (field === 'environment.branch') {
      console.log(profile.environments[environment]?.branch ?? '');
      return;
    }
    const value = readField(profile, field, environment);
    console.log(typeof value === 'object' ? JSON.stringify(value) : value);
    return;
  }
  if (command === 'has-client-stage') process.exit(hasClientStage(profile, environment) ? 0 : 1);
  if (command === 'needs-client') {
    if (!options['--repo'] || !options['--branch']) throw new Error('needs-client 必须提供 --repo 和 --branch');
    process.exit(needsClient(profile, resolve(options['--repo']), options['--branch'], environment) ? 0 : 1);
  }
  throw new Error(`未知命令: ${command}`);
};

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
