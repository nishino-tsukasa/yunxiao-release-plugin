#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tokenKey = 'YUNXIAO_ACCESS_TOKEN';

export const resolveCodexEnvPath = (env = process.env) =>
  resolve(env.CODEX_HOME || resolve(env.HOME || env.USERPROFILE || homedir(), '.codex'), '.env');

export const resolveCredentialPath = (env = process.env) => {
  const home = [env.HOME, env.USERPROFILE].find((value) => value && isAbsolute(value)) || homedir();
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME
    : resolve(home, '.config');
  return resolve(configHome, 'yunxiao-release/credentials.env');
};

export const upsertToken = (content, token) => {
  if (!token || /[\r\n]/.test(token)) {
    throw new Error('Token 不能为空或包含换行符');
  }
  const retainedLines = content.split(/\r?\n/).filter((line) => !line.startsWith(`${tokenKey}=`));
  return `${[...retainedLines.filter(Boolean), `${tokenKey}=${token}`].join('\n')}\n`;
};

export const hasConfiguredToken = (content) =>
  content.split(/\r?\n/).some((line) => line.startsWith(`${tokenKey}=`) && line.slice(tokenKey.length + 1).trim());

// 终端使用 raw mode 隐藏输入；管道模式只读取 stdin，避免把 Token 放进命令参数和历史。
const readToken = async () => {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8').trim();
  }
  process.stdout.write(`请输入 ${tokenKey}（输入不可见）：`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolveToken, reject) => {
    const characters = [];
    process.stdin.on('data', (buffer) => {
      for (const character of buffer.toString('utf8')) {
        if (character === '\u0003') return reject(new Error('已取消'));
        if (character === '\r' || character === '\n') return resolveToken(characters.join(''));
        if (character === '\u007f') characters.pop();
        else characters.push(character);
      }
    });
  }).finally(() => {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  });
};

// 原子更新 Codex Home .env，避免 Token 写到一半时破坏现有环境。
export const writeEnvFile = (filePath, updateContent) => {
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, updateContent(current), { flag: 'wx', mode: 0o600 });
    renameSync(temporaryPath, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
};

export const writeToken = (filePath, token) => writeEnvFile(filePath, (content) => upsertToken(content, token));

export const migrateLegacyToken = (env = process.env) => {
  const credentialPath = resolveCredentialPath(env);
  if (existsSync(credentialPath) && hasConfiguredToken(readFileSync(credentialPath, 'utf8'))) return credentialPath;
  const legacyPath = resolveCodexEnvPath(env);
  if (!existsSync(legacyPath)) return credentialPath;
  const tokenLine = readFileSync(legacyPath, 'utf8').split(/\r?\n/).find((line) => line.startsWith(`${tokenKey}=`));
  const token = tokenLine?.slice(tokenKey.length + 1).trim();
  if (token) writeToken(credentialPath, token);
  return credentialPath;
};

export const syncCodexToken = (env = process.env) => {
  const credentialPath = migrateLegacyToken(env);
  if (!existsSync(credentialPath)) return false;
  const tokenLine = readFileSync(credentialPath, 'utf8').split(/\r?\n/).find((line) => line.startsWith(`${tokenKey}=`));
  const token = tokenLine?.slice(tokenKey.length + 1).trim();
  if (!token) return false;
  writeToken(resolveCodexEnvPath(env), token);
  return true;
};

const main = async () => {
  const envPath = migrateLegacyToken();
  if (process.argv.includes('--check')) {
    const configured = existsSync(envPath) && hasConfiguredToken(readFileSync(envPath, 'utf8'));
    if (configured) syncCodexToken();
    console.log(configured ? `${tokenKey} 已配置：${envPath}` : `${tokenKey} 未配置：${envPath}`);
    process.exitCode = configured ? 0 : 1;
    return;
  }
  writeToken(envPath, await readToken());
  syncCodexToken();
  console.log(`${tokenKey} 已安全写入 ${envPath}`);
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    // --check 用 1 表示未配置，实际读取错误必须使用不同状态，避免安装器误触发重新输入。
    process.exitCode = process.argv.includes('--check') ? 2 : 1;
  });
}
