// 极简日志：stdout + 可选文件（大小轮转，避免 24 小时运行写满磁盘）。
import fs from 'node:fs';
import path from 'node:path';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const KEEP_FILES = 2;

let logFile: string | null = null;

export function initLogFile(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'server.log');
  } catch {
    logFile = null;
  }
}

function writeLine(level: string, msg: string): void {
  const line = `${new Date().toISOString()} [${level}] ${msg}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      for (let i = KEEP_FILES - 1; i >= 1; i--) {
        const from = `${logFile}.${i}`;
        const to = `${logFile}.${i + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(logFile, `${logFile}.1`);
    }
    fs.appendFileSync(logFile, line + '\n');
  } catch {
    /* 文件日志失败不影响服务 */
  }
}

export const log = {
  info: (msg: string) => writeLine('INFO', msg),
  warn: (msg: string) => writeLine('WARN', msg),
  error: (msg: string) => writeLine('ERROR', msg),
};

/** 对外安全消息：绝不输出完整带 token 的 URL 或笔记正文 */
export function redactUrl(u: string): string {
  try {
    const url = new URL(u);
    return url.origin + url.pathname;
  } catch {
    return u.slice(0, 80);
  }
}
