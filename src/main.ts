/**
 * 万象的启动入口。boot 逻辑在 src/boot.ts（探针与生产共用同一条路径），
 * 这里只负责入口该管的事：key 同步、遗留设置清理、启动自愈、打印地址、
 * 信号处理。
 */
import { syncKeyEnv, resolveKey } from "./config";
import { APPS_DIR, healInstalledPresets, pruneLegacyDshSettings } from "./server";
import { bootWanxiang, PORT } from "./boot";

async function main(): Promise<void> {
  // key 可能存在万象的配置文件里；运行内核的 llm 适配器按 env 名解析，先同步。
  syncKeyEnv();

  // 一次性：抹掉旧版万象写进内核 settings.yaml 的遗留键（全局默认 preset、
  // onboarding 确认、locale）。它们的消费者都已不在组合里；其中
  // agent-presets.default 尤其危险——那是「内核还持有当前助手」的最后一处。
  await pruneLegacyDshSettings();

  const ctx = await bootWanxiang();

  // 旧编译器装出来的 preset 可能缺当前基线的工具行——启动时自愈一遍。
  await healInstalledPresets();

  const port = ctx.get("webServer")?.port ?? PORT;
  console.log(`万象已启动: http://127.0.0.1:${port}`);
  console.log(`应用落盘目录: ${APPS_DIR}`);
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
