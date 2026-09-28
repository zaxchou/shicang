// 带硬性超时的 git push：仓库在网络盘（Z:）上，打包本身要几十秒到两分钟，
// 而一旦凭据助手需要人工确认，没有上限的 push 会把长任务无限期挂住。
// 这里给一个上限：超时就放弃并明确报错，提交仍在本地，下次补推即可。
//
// 用法：
//   node scripts/git-push.mjs                 # 推当前分支
//   node scripts/git-push.mjs --tags          # 连 tag 一起推
//   node scripts/git-push.mjs --timeout 120   # 改上限（秒）
//
// 背景与排查方法见 README 的「git 推送凭据（本机）」一节。
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const timeoutIdx = args.indexOf('--timeout');
const timeoutSec = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 240;
const withTags = args.includes('--tags');
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
  console.error('--timeout 需要一个正整数（秒）');
  process.exit(2);
}

/** 当前分支名（detached 时返回 null） */
function currentBranch() {
  return new Promise((resolve) => {
    const p = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out.trim() && out.trim() !== 'HEAD' ? out.trim() : null));
  });
}

const branch = await currentBranch();
const pushArgs = ['push', 'origin', ...(branch ? [branch] : []), ...(withTags ? ['--follow-tags'] : [])];
console.log(`$ git ${pushArgs.join(' ')}  （上限 ${timeoutSec}s）`);

const child = spawn('git', pushArgs, { stdio: 'inherit' });
const timer = setTimeout(() => {
  child.kill();
  console.error(
    `\n推送超过 ${timeoutSec} 秒仍未完成，已放弃。\n` +
      '提交都还在本地，下次直接重跑即可；若反复超时，按 README「git 推送凭据（本机）」排查凭据。'
  );
  process.exit(124);
}, timeoutSec * 1000);

child.on('close', (code) => {
  clearTimeout(timer);
  if (code === 0) console.log('推送完成。');
  else console.error(`git push 退出码 ${code}（未推送成功；提交仍在本地）`);
  process.exit(code ?? 1);
});
