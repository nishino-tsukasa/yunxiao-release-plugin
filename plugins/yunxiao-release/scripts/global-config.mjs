import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const resolveGlobalConfigDir = (env = process.env) => {
  const home = [env.HOME, env.USERPROFILE].find((value) => value && isAbsolute(value)) || homedir();
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : resolve(home, '.config');
  return resolve(configHome, 'yunxiao-release');
};

export const resolveGlobalDefaultsPath = (env = process.env) => resolve(resolveGlobalConfigDir(env), 'global-defaults.json');
export const resolveGlobalRepositoriesPath = (env = process.env) => resolve(resolveGlobalConfigDir(env), 'global-repositories.json');
export const resolveLegacyGlobalConfigPath = (env = process.env) => resolve(resolveGlobalConfigDir(env), 'projects.json');

export const normalizeRemoteUrl = (value) => {
  const remote = String(value || '').trim().replace(/\/$/, '').replace(/\.git$/, '');
  if (!remote) return null;
  const scpMatch = remote.match(/^[^@\s]+@([^:\s]+):(.+)$/);
  if (scpMatch) return `${scpMatch[1].toLowerCase()}/${scpMatch[2].replace(/^\/+/, '')}`;
  try {
    const url = new URL(remote);
    return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+/, '')}`;
  } catch {
    return null;
  }
};

export const readJson = (filePath, label = 'JSON') => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取${label} ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export const readGlobalConfigFiles = (env = process.env) => {
  const defaultsPath = resolveGlobalDefaultsPath(env);
  const repositoriesPath = resolveGlobalRepositoriesPath(env);
  const legacyPath = resolveLegacyGlobalConfigPath(env);
  if (!existsSync(defaultsPath) && !existsSync(repositoriesPath) && existsSync(legacyPath)) {
    const legacy = readJson(legacyPath, '旧全局项目配置');
    return {
      defaults: legacy.defaults ?? {}, repositories: legacy.repositories ?? {},
      defaultsPath, repositoriesPath, source: 'legacy',
    };
  }
  const rawDefaults = existsSync(defaultsPath) ? readJson(defaultsPath, '全局默认配置') : {};
  const rawRepositories = existsSync(repositoriesPath) ? readJson(repositoriesPath, '全局仓库配置') : {};
  if (rawDefaults.schemaVersion !== undefined && rawDefaults.schemaVersion !== 1) throw new Error('全局默认配置 schemaVersion 必须为 1');
  if (rawRepositories.schemaVersion !== undefined && rawRepositories.schemaVersion !== 1) throw new Error('全局仓库配置 schemaVersion 必须为 1');
  const { schemaVersion: _defaultsVersion, ...defaults } = rawDefaults;
  const repositories = rawRepositories.repositories ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('全局默认配置必须是对象');
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) throw new Error('全局 repositories 必须是对象');
  if (Object.hasOwn(defaults, 'repositoryId')) throw new Error('全局默认配置不能包含 repositoryId');
  return { defaults, repositories, defaultsPath, repositoriesPath, source: 'split' };
};

const readRemoteUrl = (rootDir, remoteName) => {
  const result = spawnSync('git', ['config', '--get', `remote.${remoteName}.url`], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

const listRemoteNames = (rootDir) => {
  const result = spawnSync('git', ['remote'], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
};

export const readGlobalProjectConfig = (rootDir, env = process.env, remoteName = '') => {
  const global = readGlobalConfigFiles(env);
  const configuredRemote = remoteName || global.defaults.remoteName || '';
  const candidates = configuredRemote ? [configuredRemote] : listRemoteNames(rootDir);
  const matches = candidates.map((name) => ({ name, key: normalizeRemoteUrl(readRemoteUrl(rootDir, name)) }))
    .filter(({ key }) => key && Object.hasOwn(global.repositories, key));
  if (matches.length > 1) throw new Error('多个 Git remote 命中全局仓库配置，请显式配置 remoteName');
  const repositoryKey = matches[0]?.key ?? null;
  const repository = repositoryKey ? global.repositories[repositoryKey] ?? {} : {};
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new Error(`全局仓库配置必须是对象: ${repositoryKey}`);
  }
  return { config: { ...global.defaults, ...repository }, repositoryKey, remoteName: matches[0]?.name ?? configuredRemote, ...global };
};
