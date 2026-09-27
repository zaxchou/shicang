// NAS 部署助手：通过 SSH 在群晖上执行命令（密码经环境变量传入，不写入任何文件）。
// 用法：
//   NAS_HOST=192.168.31.246 NAS_USER=zaxchou NAS_PASS=... node scripts/nas-deploy.mjs probe
//   NAS_HOST=... node scripts/nas-deploy.mjs exec "uname -a"           # 普通用户执行
//   NAS_HOST=... node scripts/nas-deploy.mjs sudo "docker ps"          # sudo 执行（密码走 stdin）
//   NAS_HOST=... node scripts/nas-deploy.mjs sudo-sh "<多行脚本>"       # 整段脚本以 root 执行
import { Client } from 'ssh2';

const host = process.env.NAS_HOST;
const user = process.env.NAS_USER;
const pass = process.env.NAS_PASS;
if (!host || !user || !pass) {
  console.error('需要环境变量 NAS_HOST / NAS_USER / NAS_PASS');
  process.exit(2);
}

const mode = process.argv[2] ?? 'probe';
const arg = process.argv[3];

function connect() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn
      .on('ready', () => resolve(conn))
      .on('error', reject)
      .connect({ host, port: 22, username: user, password: pass, readyTimeout: 20000, keepaliveInterval: 10000 });
  });
}

function run(conn, cmd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    conn.exec(cmd, (err, stream) => {
      if (err) {
        resolve({ code: -1, stdout: '', stderr: String(err) });
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        resolve({ code: -2, stdout, stderr: stderr + '\n[超时]' });
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        })
        .on('data', (d) => {
          stdout += d.toString();
          process.stdout.write(d.toString());
        })
        .stderr.on('data', (d) => {
          stderr += d.toString();
          process.stderr.write(d.toString());
        });
    });
  });
}

/** sudo 执行：密码第一行走 stdin，其余 stdin 作为脚本交给 sh，避免转义问题 */
function runSudoScript(conn, script, timeoutMs = 300000) {
  return new Promise((resolve) => {
    conn.exec("sudo -S -p '' /bin/sh", (err, stream) => {
      if (err) {
        resolve({ code: -1, stdout: '', stderr: String(err) });
        return;
      }
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        stream.close();
        resolve({ code: -2, stdout, stderr: stderr + '\n[超时]' });
      }, timeoutMs);
      stream
        .on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, stdout, stderr });
        })
        .on('data', (d) => {
          stdout += d.toString();
          process.stdout.write(d.toString());
        })
        .stderr.on('data', (d) => {
          stderr += d.toString();
          process.stderr.write(d.toString());
        });
      stream.write(`${pass}\n`);
      stream.write(script);
      stream.end();
    });
  });
}

const conn = await connect();
const code = await (async () => {
  if (mode === 'probe') {
    const cmds = [
      'whoami && id',
      'uname -m',
      'cat /etc/VERSION 2>/dev/null | head -4',
      'export PATH=/usr/local/bin:$PATH; docker --version; docker compose version | head -1',
      'test -d /volume2/Media/BaiduNetdiskWorkspace/myagent-work/zcode/MyInfobase && echo PROJECT-OK',
      'test -d /volume2/Media/BaiduNetdiskWorkspace/mynote/mynote/RedNote/Bookmarks && echo SOURCE-OK',
    ];
    for (const c of cmds) {
      console.log(`\n$ ${c}`);
      const r = await run(conn, c, 30000);
      if (r.code !== 0) return r.code;
    }
    return 0;
  }
  if (mode === 'exec') {
    const r = await run(conn, arg, Number(process.env.NAS_TIMEOUT ?? 120) * 1000);
    return r.code;
  }
  if (mode === 'sudo' || mode === 'sudo-sh') {
    const script = mode === 'sudo' ? `${arg}\n` : arg;
    const r = await runSudoScript(conn, script, Number(process.env.NAS_TIMEOUT ?? 600) * 1000);
    return r.code;
  }
  console.error('未知模式:', mode);
  return 2;
})();
conn.end();
process.exit(code === 0 ? 0 : 1);
