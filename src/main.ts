/**
 * 万象的启动入口：boot 一条 `wanxiang` profile —— dsh-base + dsh-web-app +
 * @centaur/wanxiang —— 一个进程、一个端口。
 *
 * 以前是两个进程：万象自己起 node:http 服务，再 spawn 一个 `dsh web` 子进程，
 * 中间隔着约 300 行 HTTP/WebSocket 反向代理和一个满页替换文本节点的换牌脚本。
 * 现在 DSH 的 webserver 就是唯一的服务器：万象 bundle 把界面挂在 exact `/`、
 * API 挂在 prefix `/wanx`，DSH 的 SPA 留在 fallback（「细聊」开在 /chat——
 * SPA 对无扩展名路径回退 index.html）。「跑一次」和细聊共享同一个 ctx，
 * 同一个 agent 平面——两边工具集不一致的 bug 从结构上消失。
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncKeyEnv, resolveKey } from "./config";
import { acknowledgeDshOnboarding, APPS_DIR, healInstalledPresets } from "./server";

const require = createRequire(import.meta.url);
const PROJECT = join(dirname(fileURLToPath(import.meta.url)), "..");

const PORT = Number(process.env.WANXIANG_PORT ?? 8788);
const DSH_HOME = process.env.WANXIANG_DSH_HOME ?? join(PROJECT, ".dsh-home");

/** 万象 profile 的三层组合。顺序即层叠顺序，后面的盖前面的。 */
const BUNDLES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@centaur/wanxiang"];

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
  const desired = {
    name: "dsh-profile-wanxiang",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: BUNDLES } },
  };
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(manifest, "utf-8"));
  } catch {
    current = null;
  }
  const currentBundles = (current as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh
    ?.profile?.bundles;
  if (JSON.stringify(currentBundles) !== JSON.stringify(BUNDLES)) {
    writeFileSync(manifest, JSON.stringify(desired, null, 2) + "\n", "utf-8");
  }

  const linkDir = join(profileDir, "node_modules", "@centaur");
  const link = join(linkDir, "wanxiang");
  if (!existsSync(link)) {
    mkdirSync(linkDir, { recursive: true });
    symlinkSync(join(PROJECT, "packages", "wanxiang-bundle"), link, "dir");
  }
}

async function main(): Promise<void> {
  process.env.DSH_HOME = DSH_HOME;

  // key 可能存在万象的配置文件里；DSH 的 llm 适配器按 env 名解析，先同步。
  syncKeyEnv();

  // 首启动的欢迎页确认 + 中文 locale，写进 DSH 的 settings.yaml。
  await acknowledgeDshOnboarding();

  const { boot, loadProfile, healProfilesModuleFallback, watchUserPatches } = await import(
    "@deepseek-ai/dsh-app-boot"
  );
  const { provideCmdline } = await import("@deepseek-ai/dsh-cmdline");
  const INSTALL_ANCHOR = require.resolve("@deepseek-ai/dsh/package.json");

  // 插件解析的软链农场。从没跑过 dsh 的机器上不铺这个，boot 会炸在一条
  // 看不出病因的 loader 错误上。幂等。
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
    // web 组合把 HMR 禁了（生产姿态）。这里窄根重开：主 watcher 只盯 profile
    // 目录（node_modules 默认忽略，几乎不动），真正要的是 registerConfig——
    // 它独立盯 cordis.patch.yml，改文件即事务性重组整个 patch 栈。
    // 「接外部能力（MCP）」的热生效靠的就是这条。
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
  const patches = [...bundlePatches, ...(profile as any).patches, ...overlays];

  const ctx = await boot("wanxiang", rootConfigPath, patches, (bootCtx: any) => {
    // web-startup（shipped 的 CLI 参数解析器）等 cmdlineArgs；webserver 与
    // web-runtime 再从它懒读 host/port/openBrowser。喂一份我们自己的 argv，
    // 整条 shipped 链原样可用——不用去覆写那几行带 !!js 的 config。
    provideCmdline(bootCtx, {
      args: ["--no-open", "--host", "127.0.0.1", "--port", String(PORT)],
      exit: (code?: number) => process.exit(typeof code === "number" ? code : 0),
    });

    // cordis 的默认 logger exporter 只写内存 buffer——不接一个 console sink，
    // 运行时的一切（插件激活失败、热重组报错、MCP 断连）都是哑的。
    bootCtx.logger.exporter({
      colors: 0,
      export: (m: any) => {
        if (m?.type === "debug") return;
        const args = Array.isArray(m?.args) ? m.args : [m];
        console.log(`[${m?.name ?? "dsh"}]`, ...args);
      },
    });
  });

  // 旧编译器装出来的 preset 在 web profile 下没有文件工具——启动时自愈一遍。
  await healInstalledPresets();

  // 盯住 profile 的用户补丁层：MCP 接入写的就是这份文件，改完热生效。
  // compose 负责重建完整的 patch 栈——watcher 会用它整个替换根 Include 的 patches。
  try {
    await watchUserPatches(ctx, {
      binName: "wanxiang",
      filename: (profile as any).patchPath ?? join(profile.dir, "cordis.patch.yml"),
      compose: (userPatches: unknown[]) => [...bundlePatches, ...userPatches, ...overlays],
    });
  } catch (e) {
    console.warn(
      "补丁层热重载没挂上（改 MCP 配置后需要重启才生效）:",
      e instanceof Error ? e.message : e,
    );
  }

  const port = ctx.get("webServer")?.port ?? PORT;
  console.log(`万象已启动: http://127.0.0.1:${port}`);
  console.log(`应用落盘目录: ${APPS_DIR}`);
  console.log(`细聊（DSH 完整界面）: http://127.0.0.1:${port}/chat`);
  if (!resolveKey()) {
    console.warn("提示: 还没配置模型 key，打开页面后第一屏就能填");
  }

  let disposing = false;
  const shutdown = (): void => {
    if (disposing) process.exit(1);
    disposing = true;
    void ctx.fiber
      .dispose()
      .catch(() => {})
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("万象启动失败:", e instanceof Error ? e.message : e);
  process.exit(1);
});
