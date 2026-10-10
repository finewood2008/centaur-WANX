import {
  createContext,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  Layout,
  List,
  Menu,
  Space,
  Tag,
  Typography,
} from "antd";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { CurrentUserProvider } from "../../hooks/useCurrentUser";
import { AgentProvider } from "../../context/AgentContext";
import { LayoutModeProvider } from "../../context/LayoutModeContext";
import { VoiceOutputProvider } from "../../context/VoiceOutputContext";
import { clearAuthToken, setActiveAgentId } from "../../api/request";
import { stopBoxSession } from "../../utils/boxConnection";
import { buildNavSections } from "../../layouts/sidebarNav";
import PageShell from "../../layouts/PageShell";
import type { DesktopClientState } from "../../utils/desktopClient";
const MainLayout = lazy(() => import("../../layouts/MainLayout"));
const ClientContext = createContext<DesktopClientState | null>(null);
export function useDesktopClientState() {
  return useContext(ClientContext);
}

export function DesktopClientBar() {
  const state = useDesktopClientState();
  const { t } = useTranslation();
  return (
    <div
      style={{
        padding: "10px 18px",
        borderBottom: "1px solid var(--fn-border-color)",
        flexShrink: 0,
      }}
    >
      <Space wrap>
        <strong>{t("desktopClient.name")}</strong>
        <Tag color={state?.phase === "ready" ? "green" : "default"}>
          {t(`desktopClient.${state?.phase || "disconnected"}`)}
        </Tag>
        {state?.box && (
          <span>
            {state.box.name} ·{" "}
            {state.box.mode === "p2p" ? "P2P Direct" : "HTTPS"}
          </span>
        )}
        {state?.user && (
          <span>
            {state.user.display_name || state.user.username} · {state.user.role}
          </span>
        )}
        {state?.phase === "ready" && (
          <Button
            size="small"
            onClick={() =>
              void window.wanxDesktop?.action("connection.disconnect")
            }
          >
            {t("desktopClient.disconnect")}
          </Button>
        )}
      </Space>
    </div>
  );
}

export function DesktopBoxesPage() {
  const state = useDesktopClientState();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [account] = Form.useForm();
  const [direct] = Form.useForm();
  const [link] = Form.useForm();
  async function invoke(action: string, input: Record<string, unknown> = {}) {
    setBusy(true);
    setError("");
    try {
      await window.wanxDesktop!.action(action, input);
      account.resetFields(["password", "code"]);
      direct.resetFields(["password", "captchaToken"]);
      link.resetFields(["password"]);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "CLIENT_REQUEST_FAILED",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <PageShell
      title={t("boxes.title")}
      subtitle={t("desktopClient.boxSubtitle")}
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message={t("desktopClient.accountBoundary")}
          description={t("desktopClient.sdkFlow")}
        />
        {!state?.platformConfigured && (
          <Alert
            type="warning"
            message={t("desktopClient.deploymentMissing")}
          />
        )}
        {error && <Alert type="error" message={error} />}
        <Card title={t("desktopClient.platformAccount")}>
          {state?.identity ? (
            <Space wrap>
              <Tag color="green">{t("desktopClient.platformSignedIn")}</Tag>
              <Typography.Text>{state.identity.accountId}</Typography.Text>
              <Button
                disabled={busy}
                onClick={() => void invoke("devices.list")}
              >
                {t("desktopClient.refreshDevices")}
              </Button>
              <Button
                disabled={busy}
                onClick={() => void invoke("account.logout")}
              >
                {t("desktopClient.logout")}
              </Button>
            </Space>
          ) : (
            <>
              <Form
                name="platform-account"
                form={account}
                layout="vertical"
                style={{ maxWidth: 480 }}
                onFinish={(value) =>
                  void invoke(
                    value.code ? "account.sms" : "account.password",
                    value,
                  )
                }
              >
                <Form.Item
                  name="phone"
                  label={t("desktopClient.phone")}
                  rules={[{ required: true }]}
                >
                  <Input autoComplete="username" />
                </Form.Item>
                <Form.Item name="password" label={t("desktopClient.password")}>
                  <Input.Password autoComplete="current-password" />
                </Form.Item>
                <Form.Item name="code" label={t("desktopClient.smsCode")}>
                  <Input autoComplete="one-time-code" />
                </Form.Item>
                <Space>
                  <Button
                    loading={busy}
                    disabled={!state?.platformConfigured}
                    type="primary"
                    htmlType="submit"
                  >
                    {t("desktopClient.login")}
                  </Button>
                  <Button
                    disabled={busy || !state?.platformConfigured}
                    onClick={() =>
                      void invoke("account.sendSMS", {
                        phone: account.getFieldValue("phone"),
                      })
                    }
                  >
                    {t("desktopClient.sendSMS")}
                  </Button>
                  <Button
                    disabled={busy || !state?.platformConfigured}
                    onClick={() => void invoke("account.current")}
                  >
                    {t("desktopClient.restore")}
                  </Button>
                </Space>
              </Form>
            </>
          )}
        </Card>
        <Card title={t("desktopClient.authorizedDevices")}>
          <List
            dataSource={state?.devices || []}
            locale={{ emptyText: t("desktopClient.noDevices") }}
            renderItem={(device) => (
              <List.Item
                actions={[
                  <Button
                    key="connect"
                    type="primary"
                    loading={busy || state?.phase === "connecting"}
                    disabled={
                      !device.online ||
                      !state?.platformConfigured ||
                      state?.box?.id === device.deviceId
                    }
                    onClick={() => {
                      const values = link.getFieldsValue();
                      void invoke("connection.connect", {
                        deviceId: device.deviceId,
                        ...(values.username && values.password
                          ? { linkExisting: values }
                          : {}),
                      });
                    }}
                  >
                    {t("boxes.connect")}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      {device.deviceName || device.deviceId}
                      <Tag color={device.online ? "green" : "default"}>
                        {t(
                          device.online
                            ? "desktopClient.online"
                            : "desktopClient.offline",
                        )}
                      </Tag>
                    </Space>
                  }
                  description={`${device.deviceId} · ${
                    device.role
                  } · ${device.scopes.join(", ")}`}
                />
              </List.Item>
            )}
          />
          <Collapse
            items={[
              {
                key: "link",
                label: t("desktopClient.linkExisting"),
                children: (
                  <>
                    <Typography.Paragraph>
                      {t("desktopClient.linkHelp")}
                    </Typography.Paragraph>
                    <Form
                      name="local-box-link"
                      form={link}
                      layout="vertical"
                      style={{ maxWidth: 480 }}
                    >
                      <Form.Item
                        name="username"
                        label={t("desktopClient.localUsername")}
                      >
                        <Input />
                      </Form.Item>
                      <Form.Item
                        name="password"
                        label={t("desktopClient.localPassword")}
                      >
                        <Input.Password autoComplete="off" />
                      </Form.Item>
                    </Form>
                  </>
                ),
              },
            ]}
          />
        </Card>
        <Collapse
          items={[
            {
              key: "direct",
              label: t("desktopClient.directTitle"),
              children: (
                <>
                  <Typography.Paragraph>
                    {t("desktopClient.directHelp")}
                  </Typography.Paragraph>
                  <Form
                    name="direct-box"
                    form={direct}
                    layout="vertical"
                    style={{ maxWidth: 600 }}
                    onFinish={(value) =>
                      void invoke("connection.direct", value)
                    }
                  >
                    <Form.Item
                      name="baseURL"
                      label={t("boxes.url")}
                      rules={[{ required: true }]}
                    >
                      <Input placeholder="https://wanx.example.com" />
                    </Form.Item>
                    <Form.Item
                      name="username"
                      label={t("desktopClient.localUsername")}
                      rules={[{ required: true }]}
                    >
                      <Input />
                    </Form.Item>
                    <Form.Item
                      name="password"
                      label={t("desktopClient.localPassword")}
                      rules={[{ required: true }]}
                    >
                      <Input.Password autoComplete="off" />
                    </Form.Item>
                    <Form.Item
                      name="captchaToken"
                      label={t("desktopClient.captchaProof")}
                    >
                      <Input autoComplete="off" />
                    </Form.Item>
                    <Button loading={busy} htmlType="submit">
                      {t("boxes.connect")}
                    </Button>
                  </Form>
                </>
              ),
            },
          ]}
        />
      </Space>
    </PageShell>
  );
}

export default function DesktopWorkspace() {
  const [state, setState] = useState<DesktopClientState | null>(null);
  const [user, setUser] = useState<DesktopClientState["user"]>(null);
  const sessionRef = useRef<string | null>(null);
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    let active = true;
    const accept = (value: DesktopClientState) => {
      if (!active) return;
      setState(value);
      setUser(value.user);
      sessionRef.current = value.sessionId;
      if (value.phase !== "ready") {
        clearAuthToken();
        setActiveAgentId(null);
        localStorage.removeItem("octop:active-agent");
      }
    };
    void window.wanxDesktop!.action("state").then(accept);
    const unsubscribe = window.wanxDesktop!.subscribe((value) => {
      if (value.phase === "ready" && value.sessionId !== sessionRef.current) {
        window.location.assign("/boxes");
        return;
      }
      if (value.phase !== "ready") stopBoxSession("switch");
      accept(value);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  const sections = buildNavSections(null, { desktopClient: true });
  return (
    <ClientContext.Provider value={state}>
      {state?.phase === "ready" ? (
        <CurrentUserProvider user={user} setUser={setUser}>
          <AgentProvider key={state.sessionId}>
            <LayoutModeProvider>
              <VoiceOutputProvider>
                <Suspense fallback={null}>
                  <MainLayout />
                </Suspense>
              </VoiceOutputProvider>
            </LayoutModeProvider>
          </AgentProvider>
        </CurrentUserProvider>
      ) : (
        <Layout
          style={{ minHeight: "100dvh", background: "var(--fn-bg-layout)" }}
        >
          <Layout.Sider
            width={220}
            style={{
              background: "var(--fn-bg-container)",
              borderRight: "1px solid var(--fn-border-color)",
            }}
          >
            <Typography.Title level={4} style={{ padding: "24px 20px" }}>
              {t("desktopClient.name")}
            </Typography.Title>
            <Menu
              selectedKeys={[
                location.pathname.startsWith("/applications") ||
                location.pathname.startsWith("/admin/applications")
                  ? "applications"
                  : "boxes",
              ]}
              style={{ background: "transparent", border: 0 }}
              items={sections
                .flatMap((section) => section.items)
                .map((item) => ({
                  key: item.key,
                  icon: item.icon,
                  label: t(item.labelKey),
                  disabled: !["boxes", "applications"].includes(item.key),
                  onClick: () => navigate(item.path),
                }))}
            />
          </Layout.Sider>
          <Layout style={{ background: "transparent" }}>
            <DesktopClientBar />
            <Layout.Content style={{ padding: 24, overflow: "auto" }}>
              {location.pathname.startsWith("/applications") ||
              location.pathname.startsWith("/admin/applications") ? (
                <PageShell
                  title={t("applications.title")}
                  subtitle={t("desktopClient.applicationSubtitle")}
                >
                  <Alert
                    type="info"
                    showIcon
                    message={t("desktopClient.connectForApplications")}
                    action={
                      <Button onClick={() => navigate("/boxes")}>
                        {t("boxes.title")}
                      </Button>
                    }
                  />
                </PageShell>
              ) : (
                <DesktopBoxesPage />
              )}
            </Layout.Content>
          </Layout>
        </Layout>
      )}
    </ClientContext.Provider>
  );
}
