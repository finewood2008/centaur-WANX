import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { Alert, Button, ConfigProvider, Spin, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import enUS from "antd/locale/en_US";
import { useTranslation } from "react-i18next";
import { initI18n } from "../i18n";
import { authApi, type OctopUser } from "../api/modules/auth";
import { UNAUTHORIZED_EVENT } from "../api/request";
import { CurrentUserProvider } from "../hooks/useCurrentUser";
import { AgentProvider, useAgent } from "../context/AgentContext";
import { ThemeProvider, useTheme } from "../context/ThemeContext";
import { VoiceOutputProvider } from "../context/VoiceOutputContext";
import { AntdAppProvider } from "../components/AntdAppProvider";
import ErrorBoundary from "../components/ErrorBoundary";
import { userCan } from "../utils/permissions";
import "../styles/theme-vars.css";
import "../styles/centaur-ui.css";
import "./styles.css";

const Terminal = lazy(() => import("../pages/Control/Terminal"));
const Desktop = lazy(
  () => import("../pages/Control/RemoteDesktop/DesktopPanel"),
);
const tool = window.location.pathname.endsWith("/terminal")
  ? "terminal"
  : "desktop";

function TerminalTool() {
  const { t } = useTranslation();
  const { activeAgentId, agents, setActiveAgent } = useAgent();
  return (
    <>
      <label className="maintenance-agent">
        {t("maintenance.workspace")}
        <select
          aria-label={t("maintenance.workspace")}
          value={activeAgentId || ""}
          onChange={(event) => setActiveAgent(event.target.value)}
        >
          {agents.map((agent) => (
            <option key={agent.agent_id} value={agent.agent_id}>
              {agent.name}
            </option>
          ))}
        </select>
      </label>
      <div className="maintenance-surface">
        <Terminal embedded />
      </div>
    </>
  );
}

function ToolWindow() {
  const { t, i18n } = useTranslation();
  const { isDark } = useTheme();
  const [user, setUser] = useState<OctopUser | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    document.title = t(`maintenance.${tool}`);
  }, [t]);

  useEffect(() => {
    let alive = true;
    const expired = (event: Event) => {
      event.preventDefault();
      setUser(null);
      setError(true);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, expired);
    setError(false);
    void authApi
      .me()
      .then((value) => {
        if (alive) setUser(value);
      })
      .catch(() => {
        if (alive) setError(true);
      });
    return () => {
      alive = false;
      window.removeEventListener(UNAUTHORIZED_EVENT, expired);
    };
  }, [attempt]);

  const failure = (message: string) => (
    <div className="maintenance-status">
      <Alert type="error" showIcon message={message} />
      <Button onClick={() => setAttempt((value) => value + 1)}>
        {t("common.retry")}
      </Button>
    </div>
  );
  return (
    <ConfigProvider
      prefixCls="octop"
      locale={i18n.language.startsWith("zh") ? zhCN : enUS}
      theme={{
        algorithm: isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
      }}
    >
      <AntdAppProvider>
        <main
          className="maintenance-window"
          aria-label={t(`maintenance.${tool}`)}
        >
          <header className="maintenance-toolbar">
            <h1>{t(`maintenance.${tool}`)}</h1>
            <span>{t("maintenance.currentBox")}</span>
          </header>
          {error ? (
            failure(t("maintenance.connectionError"))
          ) : !user ? (
            <div className="maintenance-status">
              <Spin />
            </div>
          ) : !userCan(user, tool === "terminal" ? "terminal" : "desktop") ? (
            failure(t("common.noPermission"))
          ) : (
            <CurrentUserProvider user={user} setUser={setUser}>
              <Suspense
                fallback={
                  <div className="maintenance-status">
                    <Spin />
                  </div>
                }
              >
                {tool === "terminal" ? (
                  <AgentProvider>
                    <VoiceOutputProvider>
                      <TerminalTool />
                    </VoiceOutputProvider>
                  </AgentProvider>
                ) : (
                  <div className="maintenance-surface">
                    <Desktop embedded />
                  </div>
                )}
              </Suspense>
            </CurrentUserProvider>
          )}
        </main>
      </AntdAppProvider>
    </ConfigProvider>
  );
}

void initI18n()
  .then(() =>
    createRoot(document.getElementById("root")!).render(
      <MemoryRouter>
        <ErrorBoundary>
          <ThemeProvider>
            <ToolWindow />
          </ThemeProvider>
        </ErrorBoundary>
      </MemoryRouter>,
    ),
  )
  .catch(() => {
    document.getElementById("root")!.textContent =
      "运维工具加载失败，请关闭窗口后重新打开。";
  });
