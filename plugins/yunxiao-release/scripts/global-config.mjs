import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const resolveGlobalConfigPath = (env = process.env) => {
  const home = [env.HOME, env.USERPROFILE].find((value) => value && isAbsolute(value)) || homedir();
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : resolve(home, '.config');
  return resolve(configHome, 'yunxiao-release');
};

export const resolveGlobalDefaultsPath = (env = process.env) => resolve(resolveGlobalConfigPath(env), 'global-defaults.json');
export const resolveGlobalRepositoriesPath = (env = process.env) => resolve(resolveGlobalConfigPath(env), 'global-repositories.json');
export const resolveLegacyGlobalConfigPath = (env = process.env) => resolve(resolveGlobalConfigPath(env), 'projects.json');

export const normalizeRemoteUrl = (value) => {
  const remote = String(value || '').trim().replace(/\.git$/, '').replace(/\/$/, '');
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

const readJson = (filePath) => {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取全局项目配置 ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const readRemoteUrl = (rootDir, remoteName) => {
  const result = spawnSync('git', ['config', '--get', `remote.${remoteName}.url`], { cwd: rootDir, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

export const readGlobalProjectConfig = (rootDir, env = process.env, remoteName = 'origin') => {
  const defaultsPath = resolveGlobalDefaultsPath(env);
  const repositoriesPath = resolveGlobalRepositoriesPath(env);
  const legacyPath = resolveLegacyGlobalConfigPath(env);
  let defaults = {};
  let repositories = {};
  if (existsSync(defaultsPath) || existsSync(repositoriesPath)) {
    const rawDefaults = existsSync(defaultsPath) ? readJson(defaultsPath) : {};
    const rawRepositories = existsSync(repositoriesPath) ? readJson(repositoriesPath) : {};
    if (rawDefaults.schemaVersion !== undefined && rawDefaults.schemaVersion !== 1) throw new Error('全局默认配置 schemaVersion 必须为 1');
    if (rawRepositories.schemaVersion !== undefined && rawRepositories.schemaVersion !== 1) throw new Error('全局仓库配置 schemaVersion 必须为 1');
    const { schemaVersion: _defaultsVersion, ...defaultValues } = rawDefaults;
    defaults = defaultValues;
    repositories = rawRepositories.repositories ?? {};
  } else if (existsSync(legacyPath)) {
    const raw = readJson(legacyPath);
    if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error('旧全局项目配置 schemaVersion 必须为 1');
    defaults = raw.defaults ?? {};
    repositories = raw.repositories ?? {};
  }
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('全局 defaults 必须是对象');
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) throw new Error('全局 repositories 必须是对象');
  if (Object.hasOwn(defaults, 'repositoryId')) throw new Error('全局 defaults 不能配置 repositoryId');
  const effectiveRemoteName = remoteName || defaults.remoteName || 'origin';
  const repositoryKey = normalizeRemoteUrl(readRemoteUrl(rootDir, effectiveRemoteName));
  const repository = repositoryKey ? repositories[repositoryKey] ?? {} : {};
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new Error(`全局仓库配置必须是对象: ${repositoryKey}`);
  }
  return { config: { ...defaults, ...repository }, defaultsPath, repositoriesPath, repositoryKey };
};
