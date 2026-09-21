import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const resolveGlobalConfigPath = (env = process.env) => {
  const home = [env.HOME, env.USERPROFILE].find((value) => value && isAbsolute(value)) || homedir();
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : resolve(home, '.config');
  return resolve(configHome, 'yunxiao-release/projects.json');
};

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
  const filePath = resolveGlobalConfigPath(env);
  if (!existsSync(filePath)) return { config: {}, filePath, repositoryKey: null };
  const raw = readJson(filePath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('全局项目配置必须是 JSON 对象');
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) throw new Error('全局项目配置 schemaVersion 必须为 1');
  const defaults = raw.defaults ?? {};
  const repositories = raw.repositories ?? {};
  if (!defaults || typeof defaults !== 'object' || Array.isArray(defaults)) throw new Error('全局 defaults 必须是对象');
  if (!repositories || typeof repositories !== 'object' || Array.isArray(repositories)) throw new Error('全局 repositories 必须是对象');
  if (Object.hasOwn(defaults, 'repositoryId')) throw new Error('全局 defaults 不能配置 repositoryId');
  const effectiveRemoteName = remoteName || defaults.remoteName || 'origin';
  const repositoryKey = normalizeRemoteUrl(readRemoteUrl(rootDir, effectiveRemoteName));
  const repository = repositoryKey ? repositories[repositoryKey] ?? {} : {};
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    throw new Error(`全局仓库配置必须是对象: ${repositoryKey}`);
  }
  return { config: { ...defaults, ...repository }, filePath, repositoryKey };
};
