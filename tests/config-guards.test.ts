// 配置加载守卫：生产环境必须显式给 SOURCE_ROOT / DATA_DIR，Origin 白名单的构造规则。
// 这两块此前零覆盖——写错就是"生产跑在开发数据目录上"或"变更请求被自己的白名单挡掉"。
import { describe, expect, it } from 'vitest';
import { allowedOrigins, loadConfig, validateGroups, DEFAULT_COLLECTIONS, DEFAULT_GROUPS } from '../server/config';

describe('loadConfig', () => {
  it('生产环境缺少 DATA_DIR 时启动即报错，不回退开发数据目录', () => {
    expect(() =>
      loadConfig({ NODE_ENV: 'production', SOURCE_ROOT: 'Z:/vault' } as NodeJS.ProcessEnv)
    ).toThrow(/DATA_DIR/);
  });

  it('生产环境不给 SOURCE_ROOT 即报错——镜像里的 config/app.json 不算数', () => {
    // 旧守卫是 `!cfg.vaultRoot`，而 vaultRoot 会回退到文件里的开发路径，
    // 报错承诺永远不触发（深审发现）；现在生产必须显式给环境变量
    expect(() =>
      loadConfig({ NODE_ENV: 'production', DATA_DIR: '/app/data' } as NodeJS.ProcessEnv)
    ).toThrow(/SOURCE_ROOT/);
  });

  it('PORT 非法（NaN / 空串 / 0 / 越界）回退 4317，合法值原样生效', () => {
    // 旧代码直接 Number() 进 listen：PORT=abc 崩得看不懂，PORT= 变随机端口而白名单还按 0 校验
    expect(loadConfig({ PORT: 'abc' } as NodeJS.ProcessEnv).port).toBe(4317);
    expect(loadConfig({ PORT: '' } as NodeJS.ProcessEnv).port).toBe(4317);
    expect(loadConfig({ PORT: '0' } as NodeJS.ProcessEnv).port).toBe(4317);
    expect(loadConfig({ PORT: '70000' } as NodeJS.ProcessEnv).port).toBe(4317);
    expect(loadConfig({ PORT: '5100' } as NodeJS.ProcessEnv).port).toBe(5100);
  });

  it('EXPORT_AFTER_REFRESH 认 false/0/no/off，其余都算开', () => {
    for (const v of ['false', '0', 'no', 'OFF', ' off ']) {
      expect(loadConfig({ EXPORT_AFTER_REFRESH: v } as NodeJS.ProcessEnv).exportAfterRefresh).toBe(false);
    }
    expect(loadConfig({ EXPORT_AFTER_REFRESH: 'true' } as NodeJS.ProcessEnv).exportAfterRefresh).toBe(true);
    expect(loadConfig({} as NodeJS.ProcessEnv).exportAfterRefresh).toBe(true);
  });

  it('AUTO_REFRESH_ON_BOOT 默认开，认 false/0/no/off（v0.16 启动自动刷一次的开关）', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).autoRefreshOnBoot).toBe(true);
    for (const v of ['false', '0', 'no', 'OFF', ' off ']) {
      expect(loadConfig({ AUTO_REFRESH_ON_BOOT: v } as NodeJS.ProcessEnv).autoRefreshOnBoot).toBe(false);
    }
    expect(loadConfig({ AUTO_REFRESH_ON_BOOT: 'true' } as NodeJS.ProcessEnv).autoRefreshOnBoot).toBe(true);
  });

  it('VAULT_WRITE_ENABLED 默认开，认 false/0/no/off（v0.17 编辑写回的总开关，紧急止血用）', () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).vaultWriteEnabled).toBe(true);
    for (const v of ['false', '0', 'no', 'OFF', ' off ']) {
      expect(loadConfig({ VAULT_WRITE_ENABLED: v } as NodeJS.ProcessEnv).vaultWriteEnabled).toBe(false);
    }
    expect(loadConfig({ VAULT_WRITE_ENABLED: 'true' } as NodeJS.ProcessEnv).vaultWriteEnabled).toBe(true);
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

  it('内置默认收藏库自带排除项（config/app.json 缺失时行为不变差）', () => {
    // 此前这个断言走 loadConfig——它会读到真实的 config/app.json，默认值分支一次都没
    // 执行过，等于假绿（深审发现）。现在直接对 DEFAULT_COLLECTIONS 断言。
    const byId = new Map(DEFAULT_COLLECTIONS.map((c) => [c.id, c]));
    expect(byId.get('rednote')?.root).toBe('RedNote/Bookmarks');
    const diary = byId.get('diary');
    expect(diary?.exclude?.some((re) => new RegExp(re).test('flomo-首页.md'))).toBe(true);
    expect(diary?.exclude?.some((re) => new RegExp(re).test('闪念笔记概览.md'))).toBe(true);
    expect(diary?.exclude?.some((re) => new RegExp(re).test('flomo-xxx-首页.md'))).toBe(true);
    expect(byId.get('treasures')?.exclude?.some((re) => new RegExp(re).test('MOC.md'))).toBe(true);
    // 网页剪藏库（v0.12.0）：Clippings 目录，type web
    expect(byId.get('web')).toMatchObject({ root: 'Clippings', type: 'web', name: '网页' });
    // 微信公众号库（v0.14.0）：笔记同步助手导出，同为 web 类型（解析靠 frontmatter 形状区分方言）
    expect(byId.get('wechat')).toMatchObject({ root: '笔记同步助手', type: 'web', name: '微信公众号' });
  });

  it('内置默认分组：剪藏 = 小红书 + 网页 + 微信公众号，且通过校验', () => {
    expect(DEFAULT_GROUPS).toEqual([
      { id: 'clippings', name: '剪藏', collections: ['rednote', 'web', 'wechat'] },
    ]);
    expect(() => validateGroups(DEFAULT_COLLECTIONS, DEFAULT_GROUPS)).not.toThrow();
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.groups).toEqual(DEFAULT_GROUPS); // 真实 config/app.json 的分组与默认一致
    // 真实 config/app.json 的收藏库也要含新库（分组成员靠它校验，两边必须同步）
    expect(cfg.collections.some((c) => c.id === 'wechat' && c.root === '笔记同步助手')).toBe(true);
  });

  it('分组配置校验：组 id 撞库 id、成员不存在都在启动时报错', () => {
    // 撞名：query 的 collection 参数无法区分组与库
    expect(() =>
      validateGroups(DEFAULT_COLLECTIONS, [{ id: 'web', name: '撞名组', collections: ['rednote'] }])
    ).toThrow(/撞名/);
    // 成员写错（不存在的库 id）
    expect(() =>
      validateGroups(DEFAULT_COLLECTIONS, [
        { id: 'clippings', name: '剪藏', collections: ['rednote', 'not-a-collection'] },
      ])
    ).toThrow(/not-a-collection/);
    // 正常配置不拦
    expect(() =>
      validateGroups(DEFAULT_COLLECTIONS, [
        { id: 'clippings', name: '剪藏', collections: ['rednote', 'web', 'wechat'] },
      ])
    ).not.toThrow();
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
  // 用真实默认配置当底座（旧写法是 `as never`：参数形状完全不被类型检查）
  const base = loadConfig({} as NodeJS.ProcessEnv);

  it('开发环境包含 vite 开发端口，生产环境不包含', () => {
    const dev = allowedOrigins({ ...base, vaultRoot: 'Z:/vault', isProduction: false });
    expect(dev).toContain('http://localhost:5173');
    const prod = allowedOrigins({ ...base, vaultRoot: '/source', isProduction: true });
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
    });
    expect(list).toContain('http://192.168.31.246:4317');
    expect(list).toContain('http://nas.local:4317');
  });
});
