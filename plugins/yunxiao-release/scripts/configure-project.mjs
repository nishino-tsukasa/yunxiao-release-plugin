#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const legacyPrivatePaths = {
  localConfigFile: '.codex/yunxiao-release.local.json',
  runtimeFile: '.codex/runtime/yunxiao-release-mr.json',
  commentsFile: '.codex/runtime/yunxiao-release-comments.md',
};
const projectConfigPath = '.agents/yunxiao-release.json';
const legacyProjectConfigPath = '.codex/yunxiao-release.json';

const defaultConfig = {
  organizationId: '',
  repositoryId: '',
  reviewerMode: 'ask',
  reviewerUserIds: [],
  localConfigFile: '.agents/yunxiao-release.local.json',
  runtimeFile: '.agents/runtime/yunxiao-release-mr.json',
  commentsFile: '.agents/runtime/yunxiao-release-comments.md',
};

export const buildConfig = ({ reviewMode: _reviewMode, ...existing } = {}) => ({ ...defaultConfig, ...existing });

const toIgnoreRule = (file) => `/${file.replaceAll('\\', '/')}`;

const getPrivateRules = (config) => {
  const runtimeRules =
    config.runtimeFile === defaultConfig.runtimeFile && config.commentsFile === defaultConfig.commentsFile
      ? ['/.agents/runtime/']
      : [toIgnoreRule(config.runtimeFile), toIgnoreRule(config.commentsFile)];
  return [toIgnoreRule(config.localConfigFile), ...runtimeRules];
};

const isIgnored = (rootDir, file) => {
  const result = spawnSync('git', ['check-ignore', '--no-index', '--quiet', '--', file], { cwd: rootDir });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`无法检查 Git 忽略规则: ${result.stderr?.toString().trim() || 'git check-ignore 执行失败'}`);
};

// 普通项目只忽略本地状态；已有 .agents 整体规则时才放行共享配置，并归一化插件管理的规则。
const updateGitignore = (rootDir, config) => {
  const filePath = resolve(rootDir, '.gitignore');
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const currentLines = current.split(/\r?\n/);
  const privateRules = getPrivateRules(config);
  const hasAgentsWildcard = currentLines.includes('/.agents/*');
  const rules = hasAgentsWildcard || isIgnored(rootDir, projectConfigPath)
    ? ['!/.agents/', '/.agents/*', `!/${projectConfigPath}`, ...privateRules.filter((rule) => !rule.startsWith('/.agents/'))]
    : privateRules;
  const generatedPrivateRules = new Set([
    ...getPrivateRules(defaultConfig),
    ...[config.localConfigFile, config.runtimeFile, config.commentsFile].map(toIgnoreRule),
  ]);
  const managedRules = new Set([...rules, ...generatedPrivateRules]);
  const retainedLines = currentLines.filter((rule, index) => {
    if (hasAgentsWildcard && generatedPrivateRules.has(rule) && rule.startsWith('/.agents/')) return false;
    return !managedRules.has(rule) || currentLines.indexOf(rule) === index;
  });
  const missing = rules.filter((rule) => !retainedLines.includes(rule));
  const removedRules = retainedLines.length !== currentLines.length;
  if (!missing.length && !removedRules) return;
  const prefix = retainedLines.join('\n').trimEnd();
  const next = `${prefix ? `${prefix}\n` : ''}${missing.join('\n')}${missing.length ? '\n' : ''}`;
  writeFileSync(filePath, next);
};

// 同时校验词法路径和已存在父路径的真实位置，阻止绝对路径、穿越和符号链接逃逸。
const validateProjectPath = (rootDir, configuredPath, label) => {
  if (typeof configuredPath !== 'string' || !configuredPath || /[\r\n\0]/.test(configuredPath)) {
    throw new Error(`${label} 必须是非空项目内相对路径`);
  }
  const relativePath = relative(resolve(rootDir), resolve(rootDir, configuredPath));
  if (isAbsolute(configuredPath) || !relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(`${label} 必须是项目内相对路径`);
  }
  const existingAncestor = (() => {
    const find = (filePath) => (existsSync(filePath) ? filePath : find(dirname(filePath)));
    return find(resolve(rootDir, configuredPath));
  })();
  const realRelativePath = relative(realpathSync(rootDir), realpathSync(existingAncestor));
  if (realRelativePath.startsWith('..') || isAbsolute(realRelativePath)) {
    throw new Error(`${label} 的现有父路径必须位于项目目录内`);
  }
};

const validateProjectPaths = (rootDir, config) => {
  ['localConfigFile', 'runtimeFile', 'commentsFile', 'versionFile', 'announcementFile']
    .filter((key) => config[key] !== null && config[key] !== undefined)
    .forEach((key) => validateProjectPath(rootDir, config[key], key));
  validateProjectPath(rootDir, projectConfigPath, 'configFile');
  validateProjectPath(rootDir, '.gitignore', 'gitignoreFile');
};

// 先确保私有路径被忽略，再原子替换共享配置，失败时保留旧配置。
export const writeProjectConfig = (rootDir, config) => {
  if (!existsSync(resolve(rootDir, '.git'))) throw new Error(`当前目录不是 Git 仓库：${rootDir}`);
  validateProjectPaths(rootDir, config);
  const filePath = resolve(rootDir, projectConfigPath);
  mkdirSync(dirname(filePath), { recursive: true });
  updateGitignore(rootDir, config);
  const temporaryPath = `${filePath}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`);
    renameSync(temporaryPath, filePath);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return filePath;
};

// 迁移前统一检查冲突，禁止在两份本地状态之间猜测应采用哪一份。
const getLegacyMigrations = (rootDir, existing, config) => {
  validateProjectPaths(rootDir, config);
  return Object.entries(legacyPrivatePaths).flatMap(([key, legacyPath]) => {
    if (existing[key] !== legacyPath) return [];
    const sourcePath = resolve(rootDir, legacyPath);
    const targetPath = resolve(rootDir, config[key]);
    if (!existsSync(sourcePath)) return [];
    if (existsSync(targetPath)) throw new Error(`${key} 的新旧默认文件同时存在，请确认保留哪一份后重试`);
    return [{ sourcePath, targetPath }];
  });
};

// 无参数生成可直接编辑的共享配置；已有配置只补默认字段，避免覆盖用户值。
export const configureProject = (rootDir) => {
  const configPath = resolve(rootDir, projectConfigPath);
  const legacyConfigPath = resolve(rootDir, legacyProjectConfigPath);
  if (existsSync(configPath) && existsSync(legacyConfigPath)) {
    throw new Error('新旧项目共享配置同时存在，请确认保留哪一份后重试');
  }
  const sourcePath = existsSync(configPath) ? configPath : legacyConfigPath;
  const existing = existsSync(sourcePath) ? JSON.parse(readFileSync(sourcePath, 'utf8')) : {};
  const migrated = { ...existing };
  for (const [key, legacyPath] of Object.entries(legacyPrivatePaths)) {
    if (migrated[key] === legacyPath) migrated[key] = defaultConfig[key];
  }
  const config = buildConfig(migrated);
  const migrations = getLegacyMigrations(rootDir, existing, config);
  const writeConfig = () => {
    const result = writeProjectConfig(rootDir, config);
    if (sourcePath === legacyConfigPath && existsSync(legacyConfigPath)) rmSync(legacyConfigPath);
    return result;
  };
  if (migrations.length === 0) return writeConfig();

  updateGitignore(rootDir, config);
  for (const { targetPath } of migrations) {
    if (!isIgnored(rootDir, relative(rootDir, targetPath))) throw new Error(`迁移目标未被 Git 忽略: ${targetPath}`);
  }
  const moved = [];
  try {
    for (const migration of migrations) {
      mkdirSync(dirname(migration.targetPath), { recursive: true });
      renameSync(migration.sourcePath, migration.targetPath);
      moved.push(migration);
    }
    return writeConfig();
  } catch (error) {
    for (const migration of moved.reverse()) renameSync(migration.targetPath, migration.sourcePath);
    if (sourcePath === legacyConfigPath && existsSync(legacyConfigPath)) rmSync(configPath, { force: true });
    throw error;
  }
};

const main = () => {
  if (process.argv.includes('--help')) {
    console.log(`Usage: node configure-project.mjs\n\n在当前 Git 项目生成 ${projectConfigPath}。`);
    return;
  }
  if (process.argv.length > 2) throw new Error('configure-project 不接受参数；生成后请直接编辑配置文件');
  console.log(`项目配置已写入 ${configureProject(process.cwd())}`);
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
