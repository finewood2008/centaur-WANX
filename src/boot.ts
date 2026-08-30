/**
 * 万象的 boot 逻辑：组一条 `wanxiang` profile —— dsh-base + @centaur/wanxiang
 * —— 两层，一个进程，一个端口。
 *
 * 组合层只有万象自己：运行内核（dsh-base）提供会话 / agent / 工具注册表 /
 * 持久化 / 沙箱，界面与传输由万象的 bundle 挂上 webserver。以前夹在中间的
 * dsh-web-app（SPA、/api RPC 平面、几十个 client-ui 行）整层不在了——
 * 产品表面只有万象一个。
 *
 * 抽成独立模块是为了让探针（scripts/probe-*.ts）能走与生产完全相同的
 * boot 路径：入口 src/main.ts 与探针共用这里的 bootWanxiang()。
 */
import { createRequire } from "node:module";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PORT_RAW = Number(process.env.WANXIANG_PORT ?? 8788);
/** 非法端口回落到默认——别让 NaN 溜进 patch 里的端口表达式。 */
export const PORT =
  Number.isInteger(PORT_RAW) && PORT_RAW >= 0 && PORT_RAW <= 65535 ? PORT_RAW : 8788;
export const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");

/** 万象 profile 的两层组合。顺序即层叠顺序，后面的盖前面的。 */
export const BUNDLES = ["@deepseek-ai/dsh-base", "@centaur/wanxiang"];

/**
 * 备好 `$DSH_HOME/profiles/wanxiang/`。
 *
 * package.json 声明 bundles（loadProfile 从这里读组合层；已存在的文件它不碰，
 * 所以要在 loadProfile 之前写）。profile 本地的 node_modules 里软链上
 * @centaur/wanxiang——DSH_HOME 在仓库里时向上就能解析到 repo 的 node_modules，
 * 但 DSH_HOME 指到别处时（WANXIANG_DSH_HOME），这条软链是唯一的解析路径。
 */
function ensureProfile(): void {
  const profileDir = join(DSH_HOME, "profiles", "wanxiang");
  mkdirSync(profileDir, { recursive: true });

  // 每次对齐 bundles，而不是仅在缺失时创建：万象升级增删了一个 bundle 时，
  // 老用户的 profile 里那份 package.json 早就存在，只创建的话他永远拿不到
  // 新组合。只在真的不一致时写盘（避免每次启动都 no-op 改文件时间戳）。
  const manifest = join(profileDir, "package.json");
  let current: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf-8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
  } catch {
    /* 没有或坏了，从空开始 */
  }
  const currentBundles = (current.dsh as { profile?: { bundles?: unknown } } | undefined)?.profile
    ?.bundles;
  if (JSON.stringify(currentBundles) !== JSON.stringify(BUNDLES)) {
    // 合并而不是覆写：升级只该改 bundles，用户/pnpm 在这份 manifest 里加的
    // dependencies 或别的键不能被抹掉（老用户装过 out-of-tree 插件就在这里）。
    const next = {
      name: "dsh-profile-wanxiang",
      private: true,
      dependencies: {},
      ...current,
      dsh: {
        ...(current.dsh as Record<string, unknown> | undefined),
        profile: {
          ...((current.dsh as { profile?: Record<string, unknown> } | undefined)?.profile),
          bundles: BUNDLES,
        },
      },
    };
    writeFileSync(manifest, JSON.stringify(next, null, 2) + "\n", "utf-8");
  }

  const linkDir = join(profileDir, "node_modules", "@centaur");
  const link = join(linkDir, "wanxiang");
  const wantTarget = join(PROJECT, "packages", "wanxiang-bundle");
  mkdirSync(linkDir, { recursive: true });
  // 用 lstat 看**链接本身**（existsSync 跟随软链看目标，断链会误判成不存在，
  // 随后 symlinkSync 对仍在的链接文件抛 EEXIST，启动直接崩，且旧链指向另一份
  // checkout 时会静默加载别人的代码）。目标不符就删掉重建——仓库改名/搬动后
  // 也能自愈，不用用户手动去删软链。
  let linkOk = false;
  try {
    const st = lstatSync(link);
    if (st.isSymbolicLink() && readlinkSync(link) === wantTarget) linkOk = true;
    else rmSync(link, { force: true });
  } catch {
    /* 不存在，直接建 */
  }
  if (!linkOk) symlinkSync(wantTarget, link, "dir");
}

/**
 * boot 一棵完整的万象树，返回 settled 的根 ctx。
 *
 * 调用方（main.ts / 探针）自己决定之后做什么：注册信号处理、打印地址、
 * 或者直接开始断言。这里只负责把树立起来。
 */
export async function bootWanxiang(): Promise<any> {
  process.env.DSH_HOME = DSH_HOME;
  // patch 里 webserver 行的端口表达式读这个 env——把归一化后的值写回去，
  // 保证 YAML 看到的与这里算出的是同一个数。
  process.env.WANXIANG_PORT = String(PORT);

  const { boot, loadProfile, healProfilesModuleFallback, watchUserPatches, loadOptionalPatches } =
    await import("@deepseek-ai/dsh-app-boot");
  const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");

  // 插件解析的软链农场。从没跑过 dsh 的机器上不铺这个，boot 会炸在一条
  // 看不出病因的 loader 错误上。幂等、增量——老 home 也会被补全。
  healProfilesModuleFallback(INSTALL_ANCHOR, DSH_HOME);
  ensureProfile();

  const profile = loadProfile("dsh", "wanxiang", INSTALL_ANCHOR, undefined, { userLayer: true });
  const rootConfigPath = join(profile.dir, "cordis.yml");
  writeFileSync(rootConfigPath, "# wanxiang profile root — composed as patches\n[]\n");

  const shippedPresetRoot = join(dirname(INSTALL_ANCHOR), "config", "agent-presets");

  // dsh CLI 在启动时给 agent-presets 补 shipped root（安装目录旁的只读 preset）。
  // 我们自己 boot，得照抄这一笔；用户根 $DSH_HOME/.agent-presets 由插件默认带上。
  const overlays = [
    {
      id: "agent-presets",
      config: {
        default: "standard",
        roots: [{ path: shippedPresetRoot, trust: "system" }],
      },
    },
    // HMR 配窄根：主 watcher 只盯 profile 目录（node_modules 默认忽略，几乎
    // 不动），真正要的是 registerConfig——它独立盯 cordis.patch.yml，改文件即
    // 事务性重组整个 patch 栈。「接外部能力（MCP）」的热生效靠的就是这条。
    {
      id: "hmr",
      disabled: false,
      config: {
        base: profile.dir,
        root: ["."],
        ignored: ["**/node_modules", "**/.*", "cache", "data"],
        debounce: 200,
      },
    },
  ];
  const bundlePatches = profile.layers.flatMap((l: any) => l.patches);
  // 机器级用户补丁层（$DSH_HOME/cordis.patch.yml），层叠在 profile 补丁之后、
  // overlays 之前——和 dsh CLI 一致。丢了它，用户在这份文件里写的东西静默失效。
  const homePatchPath = join(DSH_HOME, "cordis.patch.yml");
  const readHomePatches = (): unknown[] => {
    try {
      return (loadOptionalPatches("wanxiang", homePatchPath) as unknown[]) ?? [];
    } catch {
      return [];
    }
  };
  const patches = [
    ...bundlePatches,
    ...(profile as any).patches,
    ...readHomePatches(),
    ...overlays,
  ];

  const ctx = await boot("wanxiang", rootConfigPath, patches, (bootCtx: any) => {
    // cordis 的默认 logger exporter 只写内存 buffer——不接一个 console sink，
    // 运行时的一切（插件激活失败、热重组报错、MCP 断连）都是哑的。
    bootCtx.logger.exporter({
      colors: 0,
      export: (m: any) => {
        if (m?.type === "debug") return;
        const args = Array.isArray(m?.args) ? m.args : [m];
        console.log(`[${m?.name ?? "wanxiang"}]`, ...args);
      },
    });
  });

  // 盯住 profile 的用户补丁层：MCP 接入写的就是这份文件，改完热生效。
  // compose 负责重建完整的 patch 栈——watcher 会用它整个替换根 Include 的 patches。
  try {
    await watchUserPatches(ctx, {
      binName: "wanxiang",
      filename: (profile as any).patchPath ?? join(profile.dir, "cordis.patch.yml"),
      compose: (userPatches: unknown[]) => [
        ...bundlePatches,
        ...userPatches,
        ...readHomePatches(),
        ...overlays,
      ],
    });
  } catch (e) {
    console.warn(
      "补丁层热重载没挂上（改 MCP 配置后需要重启才生效）:",
      e instanceof Error ? e.message : e,
    );
  }

  return ctx;
}
