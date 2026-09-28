// vault 边界守卫：**任何写入目录都不许落在 Obsidian 内容源里**。
//
// 为什么单独抽出来：这条纪律本来只在"语料导出"那一处做了硬断言（assertOutsideVault），
// 而数据目录 / 备份目录 / 日志目录都是配置项，配错了照样往 vault 里写——同一个保证却没有同一个守卫。
// 2026-09-28 深审把守卫抽到这里，由启动配置统一校验。
//
// 另外：词法比较（path.resolve + path.relative）拦不住软链接/目录联接（Windows junction）。
// 所以再比一次 realpath —— 把**最近的已存在祖先** realpath 出来再拼回去，目录还不存在时也能比。
import fs from 'node:fs';
import path from 'node:path';

/** child 是否等于 parent 或在其内部（纯词法判断） */
export function isInsideDir(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  const rel = path.relative(p, c);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 尽最大努力取 realpath：路径不存在时，对"最近的已存在祖先"取 realpath 再拼回剩余段 */
export function realOrSelf(target: string): string {
  const abs = path.resolve(target);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* 往下找已存在的祖先 */
  }
  const parts: string[] = [];
  let dir = abs;
  for (let i = 0; i < 32; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) return abs;
    parts.unshift(path.basename(dir));
    dir = parent;
    try {
      return path.join(fs.realpathSync.native(dir), ...parts);
    } catch {
      /* 继续往上 */
    }
  }
  return abs;
}

/**
 * 拒绝把写入目录放在内容源里。`label` 用于错误信息（告诉用户是哪个配置项错了）。
 * 错误信息保留「落在内容源里」这句，测试与文档都按它断言。
 */
export function assertOutsideVault(dir: string, vaultRoot: string, label = '导出目录'): void {
  if (!vaultRoot) return;
  if (isInsideDir(dir, vaultRoot) || isInsideDir(realOrSelf(dir), realOrSelf(vaultRoot))) {
    throw new Error(
      `${label}落在内容源里了（拒绝写入，避免污染 Obsidian 源笔记）：${path.resolve(dir)}；` +
        `内容源是 ${path.resolve(vaultRoot)}，请改到别处`
    );
  }
}
