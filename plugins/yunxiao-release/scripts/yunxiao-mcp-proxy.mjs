#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

export const remoteUrl = 'https://openapi-rdc.aliyuncs.com/ai/mcp?toolsets=organization-management,code-management,pipeline-management';

export const resolveCredentialPath = (env = process.env) => {
  const home = [env.HOME, env.USERPROFILE].find((value) => value && isAbsolute(value)) || homedir();
  const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : resolve(home, '.config');
  return resolve(configHome, 'yunxiao-release/credentials.env');
};

export const readAccessToken = (env = process.env) => {
  const path = resolveCredentialPath(env);
  if (!existsSync(path)) throw new Error(`云效全局 Token 未配置：${path}`);
  const token = readFileSync(path, 'utf8').split(/\r?\n/)
    .find((line) => line.startsWith('YUNXIAO_ACCESS_TOKEN='))
    ?.slice('YUNXIAO_ACCESS_TOKEN='.length).trim();
  if (!token) throw new Error(`云效全局 Token 未配置：${path}`);
  return token;
};

export const parseResponseMessages = (contentType, body) => {
  if (!body.trim()) return [];
  if (!contentType.toLowerCase().includes('text/event-stream')) return [JSON.parse(body)];
  return body.split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== '[DONE]')
    .map((line) => JSON.parse(line));
};

export const createForwarder = ({ env = process.env, fetchImpl = fetch } = {}) => {
  let sessionId = '';
  let protocolVersion = '';
  return async (message) => {
    const headers = {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${readAccessToken(env)}`,
      'Content-Type': 'application/json',
    };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    if (protocolVersion) headers['MCP-Protocol-Version'] = protocolVersion;
    const response = await fetchImpl(remoteUrl, { method: 'POST', headers, body: JSON.stringify(message) });
    const nextSessionId = response.headers.get('mcp-session-id');
    if (nextSessionId) sessionId = nextSessionId;
    const body = await response.text();
    if (!response.ok) throw new Error(`云效 MCP 请求失败：HTTP ${response.status}`);
    const replies = parseResponseMessages(response.headers.get('content-type') || '', body);
    if (message.method === 'initialize') {
      protocolVersion = replies.find((reply) => reply?.result?.protocolVersion)?.result.protocolVersion
        || message.params?.protocolVersion
        || '';
    }
    return replies;
  };
};

const main = async () => {
  const forward = createForwarder();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const replies = await forward(JSON.parse(line));
      replies.forEach((reply) => process.stdout.write(`${JSON.stringify(reply)}\n`));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      break;
    }
  }
};

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) main();
