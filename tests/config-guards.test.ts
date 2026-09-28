// 配置加载守卫：生产环境必须显式给 SOURCE_ROOT / DATA_DIR，Origin 白名单的构造规则。
// 这两块此前零覆盖——写错就是"生产跑在开发数据目录上"或"变更请求被自己的白名单挡掉"。
import { describe, expect, it } from 'vitest';
import { allowedOrigins, loadConfig } from '../server/config';

describe('loadConfig', () => {
  it('生产环境缺少 DATA_DIR 时启动即报错，不回退开发数据目录', () => {
    // SOURCE_ROOT 的守卫只在"配置文件和环境变量都没给 vault 根"时才会触发
    // （config/app.json 里带 vaultRoot，所以本机跑不出那条分支），这里验可复现的那条
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SOURCE_ROOT: 'Z:/vault' } as NodeJS.ProcessEnv)
    ).toThrow(/DATA_DIR/);
  });

  it('生产环境两个变量都给全时正常加载', () => {
    const cfg = loadConfig({
      NODE_ENV: 'production',
      SOURCE_ROOT: '/volume2/mynote',
      DATA_DIR: '/app/data',
    } as NodeJS.ProcessEnv);
    expect(cfg.isProduction).toBe(true);
    expect(cfg.vaultRoot).toBe('/volume2/mynote');
    expect(cfg.dataDir).toBe('/app/data');
  });

  it('环境变量优先于 config/app.json，且目录尾斜杠被规范化', () => {
    const cfg = loadConfig({
      SOURCE_ROOT: 'Z:/vault/',
      DATA_DIR: 'Z:/data/nested/',
    } as NodeJS.ProcessEnv);
    expect(cfg.vaultRoot).toBe('Z:/vault');
    expect(cfg.dataDir).toBe('Z:/data/nested');
    expect(cfg.isProduction).toBe(false);
    // 备份目录默认与数据目录同级
    expect(cfg.backupDir.replace(/\\/g, '/')).toMatch(/\/data\/backups$/);
  });

  it('三个收藏库的排除项与 config/app.json 一致（配置缺失时行为不变差）', () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    const byId = new Map(cfg.collections.map((c) => [c.id, c]));
    expect(byId.get('rednote')?.root).toBe('RedNote/Bookmarks');
    const diary = byId.get('diary');
    // flomo 的首页/导航页不是日记条目：默认值里也必须排除，否则 config/app.json 读不到时会混进来
    expect(diary?.exclude?.some((re) => new RegExp(re).test('flomo-首页.md'))).toBe(true);
    expect(diary?.exclude?.some((re) => new RegExp(re).test('闪念笔记概览.md'))).toBe(true);
  });

  it('PUBLIC_ORIGIN 去尾斜杠，EXTRA_ALLOWED_ORIGINS 按逗号切分并丢弃空项', () => {
    const cfg = loadConfig({
      PUBLIC_ORIGIN: 'http://kb.example/',
      EXTRA_ALLOWED_ORIGINS: 'http://a.example, ,http://b.example/',
    } as NodeJS.ProcessEnv);
    expect(cfg.publicOrigin).toBe('http://kb.example');
    expect(cfg.extraAllowedOrigins).toEqual(['http://a.example', 'http://b.example']);
  });
});

describe('allowedOrigins', () => {
  const base = { port: 4317, publicOrigin: '', extraAllowedOrigins: [], vaultRoot: '', isProduction: false };

  it('开发环境包含 vite 开发端口，生产环境不包含', () => {
    const dev = allowedOrigins({ ...base, vaultRoot: 'Z:/vault', isProduction: false } as never);
    expect(dev).toContain('http://localhost:5173');
    const prod = allowedOrigins({ ...base, vaultRoot: '/source', isProduction: true } as never);
    expect(prod).not.toContain('http://localhost:5173');
    expect(prod).toContain('http://localhost:4317');
    expect(prod).toContain('http://127.0.0.1:4317');
  });

  it('PUBLIC_ORIGIN 与额外来源都进白名单（NAS 局域网地址就靠它）', () => {
    const list = allowedOrigins({
      ...base,
      publicOrigin: 'http://192.168.31.246:4317',
      extraAllowedOrigins: ['http://nas.local:4317'],
      isProduction: true,
    } as never);
    expect(list).toContain('http://192.168.31.246:4317');
    expect(list).toContain('http://nas.local:4317');
  });
});
