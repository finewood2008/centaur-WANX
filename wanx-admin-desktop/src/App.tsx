import { useCallback, useEffect, useRef, useState } from "react";
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
} from "antd";
import {
  Activity,
  Box as BoxIcon,
  Cable,
  ChevronRight,
  Code2,
  Download,
  LayoutGrid,
  Monitor,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Upload,
  Users,
  Zap,
} from "lucide-react";
import {
  collection,
  emptyState,
  formatTime,
  permission,
  productPermission,
} from "./types";
import type { AdminState, Row } from "./types";
import { SelectionGuard } from "./selection.mjs";

type Call = (action: string, payload?: Row) => Promise<any>;
const workspaces = [
  {
    key: "overview",
    name: "盒子总览",
    icon: BoxIcon,
    subtitle: "设备、连接与系统运行状态",
  },
  {
    key: "settings",
    name: "系统配置",
    icon: Settings2,
    subtitle: "让平台能力为产品准备就绪",
  },
  {
    key: "desktop",
    name: "远程桌面",
    icon: Monitor,
    subtitle: "查看与维护盒子桌面",
  },
  {
    key: "products",
    name: "产品中心",
    icon: LayoutGrid,
    subtitle: "定义产品，配置资源，管理版本",
  },
  {
    key: "development",
    name: "开发工作区",
    icon: Code2,
    subtitle: "从 WANX 能力开始构建应用",
  },
  {
    key: "accounts",
    name: "账号与审计",
    icon: Users,
    subtitle: "账户授权与管理操作记录",
  },
];
const json = (value: unknown) => JSON.stringify(value, null, 2);
function JsonField({
  value,
  onChange,
  rows = 8,
}: {
  value?: string;
  onChange?: (value: string) => void;
  rows?: number;
}) {
  return (
    <Input.TextArea
      className="code-field"
      rows={rows}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
      spellCheck={false}
    />
  );
}
function NoAccess({ title = "当前账号没有此工作区权限" }: { title?: string }) {
  return (
    <Card>
      <Empty description={title} />
    </Card>
  );
}

export default function AdminApp() {
  const { message } = App.useApp();
  const [state, setState] = useState<AdminState>(emptyState),
    [workspace, setWorkspace] = useState("overview"),
    [boxModal, setBoxModal] = useState(false),
    [loginBox, setLoginBox] = useState<string>(),
    [loginLoading, setLoginLoading] = useState(false);
  const [boxForm] = Form.useForm(),
    [loginForm] = Form.useForm();
  useEffect(() => {
    if (!window.wanxAdmin) return;
    void window.wanxAdmin.invoke("state").then(setState);
    return window.wanxAdmin.onState(setState);
  }, []);
  const call: Call = useCallback(
    async (action, payload = {}) => {
      if (!window.wanxAdmin)
        throw new Error("请从 Electron 桌面应用启动万象管理员");
      try {
        return await window.wanxAdmin.invoke(action, payload, state.sessionId);
      } catch (error) {
        void message.error(error instanceof Error ? error.message : "操作失败");
        throw error;
      }
    },
    [state.sessionId, message],
  );
  const selected = workspaces.find((item) => item.key === workspace)!;
  const connected = state.status === "connected";
  const selectBox = async (id: string) => {
    if (id !== state.box?.id) await call("disconnect");
    setLoginBox(id);
    loginForm.resetFields();
  };
  return (
    <div className="admin-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Zap size={25} fill="currentColor" />
          </div>
          <div>
            <strong>万象管理员</strong>
            <span>CENTAURAI · WANX</span>
          </div>
        </div>
        <div className="nav-caption">管理工作区</div>
        <nav>
          {workspaces.map(({ key, name, icon: Icon }) => (
            <button
              key={key}
              className={workspace === key ? "selected" : ""}
              onClick={() => setWorkspace(key)}
            >
              <Icon size={19} />
              <span>{name}</span>
              {workspace === key && <ChevronRight size={15} />}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <ShieldCheck size={19} />
          <div>
            私人档案保持独立<span>管理入口不读取用户记忆和正文</span>
          </div>
        </div>
        <div className="version">公司私有产品 · V1 / 0.1.0</div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <Space size="middle">
            <div className="box-picker">
              <Cable size={17} />
              <Select
                value={state.box?.id}
                placeholder="选择盒子"
                style={{ width: 220 }}
                options={state.boxes.map((box) => ({
                  label: box.name,
                  value: box.id,
                }))}
                onChange={(id) => void selectBox(id).catch(() => {})}
              />
            </div>
            <Tag
              color={
                connected
                  ? "green"
                  : state.status === "connecting"
                  ? "blue"
                  : "default"
              }
            >
              {connected
                ? "已连接"
                : state.status === "connecting"
                ? "正在连接"
                : "未连接"}
            </Tag>
          </Space>
          <Space>
            <Tooltip title="登记盒子">
              <Button
                icon={<Plus size={16} />}
                onClick={() => {
                  boxForm.resetFields();
                  boxForm.setFieldsValue({ connection: "https" });
                  setBoxModal(true);
                }}
              >
                登记盒子
              </Button>
            </Tooltip>
            {connected ? (
              <>
                <span className="user-badge">
                  {state.user?.username} ·{" "}
                  {state.user?.role === "admin" ? "系统管理员" : "授权管理员"}
                </span>
                <Button onClick={() => void call("disconnect").catch(() => {})}>
                  断开
                </Button>
              </>
            ) : (
              state.box && (
                <Button
                  type="primary"
                  onClick={() => {
                    setLoginBox(state.box!.id);
                    loginForm.resetFields();
                  }}
                >
                  登录
                </Button>
              )
            )}
          </Space>
        </header>
        <main>
          <div className="page-heading">
            <div className="eyebrow">WANX ADMINISTRATION</div>
            <h1>{selected.name}</h1>
            <p>{selected.subtitle}</p>
          </div>
          {!window.wanxAdmin && (
            <Alert
              className="notice"
              type="warning"
              showIcon
              message="当前是界面预览，请使用 Electron 启动应用后连接盒子。"
            />
          )}
          {state.error && (
            <Alert
              className="notice"
              type="error"
              showIcon
              message={state.error}
            />
          )}
          {connected && (
            <div className="context-line">
              <span>{state.box?.name}</span>
              <span>{state.box?.baseURL || state.box?.deviceId}</span>
              <span>
                WANX {state.capabilities?.server_version || "版本未知"}
              </span>
              <span>{state.timezone}</span>
            </div>
          )}
          {workspace === "overview" && (
            <Overview state={state} call={call} selectBox={selectBox} />
          )}
          {workspace === "settings" &&
            (connected ? (
              <SystemSettings state={state} call={call} />
            ) : (
              <Disconnected />
            ))}
          {workspace === "desktop" &&
            (permission(state, "desktop") ? (
              <Desktop state={state} call={call} />
            ) : (
              <NoAccess
                title={
                  connected
                    ? "当前账号没有远程桌面查看权限"
                    : "连接盒子后查看远程桌面"
                }
              />
            ))}
          {workspace === "products" &&
            (productPermission(state) ? (
              <Products key={state.sessionId} state={state} call={call} />
            ) : (
              <NoAccess
                title={
                  connected
                    ? "当前账号没有产品管理或开发权限"
                    : "连接盒子后管理产品"
                }
              />
            ))}
          {workspace === "development" &&
            (productPermission(state) ? (
              <Development key={state.sessionId} call={call} />
            ) : (
              <NoAccess title="连接盒子并验证产品开发权限后生成工程" />
            ))}
          {workspace === "accounts" &&
            (connected ? (
              <Accounts state={state} call={call} />
            ) : (
              <Disconnected />
            ))}
        </main>
      </div>
      <Modal
        title="登记盒子"
        open={boxModal}
        onCancel={() => setBoxModal(false)}
        okText="保存到本机目录"
        onOk={() => {
          void boxForm
            .validateFields()
            .then((values) => call("boxes.save", values))
            .then(() => setBoxModal(false))
            .catch(() => {});
        }}
      >
        <Form form={boxForm} layout="vertical">
          <Form.Item label="盒子名称" name="name" rules={[{ required: true }]}>
            <Input placeholder="办公室的万象盒子" />
          </Form.Item>
          <Form.Item label="连接方式" name="connection">
            <Select
              options={[
                { value: "https", label: "可信 HTTPS / 本机开发连接" },
                { value: "p2p", label: "远程设备连接（正式身份待登记）" },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {({ getFieldValue }) =>
              getFieldValue("connection") === "p2p" ? (
                <>
                  <Alert
                    type="warning"
                    showIcon
                    message="远程连接身份尚未登记，当前仅保存设备资料，不能连接。"
                  />
                  <Form.Item
                    label="设备 ID"
                    name="deviceId"
                    rules={[{ required: true }]}
                  >
                    <Input />
                  </Form.Item>
                </>
              ) : (
                <Form.Item
                  label="WANX 服务地址"
                  name="baseURL"
                  rules={[{ required: true }]}
                  extra="HTTPS 必须具有可信证书；HTTP 仅允许本机 localhost / 127.0.0.1。"
                >
                  <Input placeholder="https://box.example.com" />
                </Form.Item>
              )
            }
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={`登录 ${
          state.boxes.find((box) => box.id === loginBox)?.name || "盒子"
        }`}
        open={Boolean(loginBox)}
        onCancel={() => {
          setLoginBox(undefined);
          loginForm.resetFields();
        }}
        confirmLoading={loginLoading}
        okText="验证账号与管理权限"
        onOk={() => {
          void loginForm
            .validateFields()
            .then(async (values) => {
              setLoginLoading(true);
              try {
                await call("connect", { boxId: loginBox, ...values });
                setLoginBox(undefined);
                loginForm.resetFields();
              } finally {
                setLoginLoading(false);
              }
            })
            .catch(() => {});
        }}
      >
        <Alert
          type="info"
          showIcon
          message="使用盒子中的 WANX 账号登录。凭据仅保存在主进程内存，断开即释放。"
        />
        <Form form={loginForm} layout="vertical" className="form-top">
          <Form.Item name="username" label="账号" rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item
            name="captchaToken"
            label="验证码证明（服务器启用验证码时）"
          >
            <Input placeholder="经服务器验证码流程取得的证明" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
function Disconnected() {
  return (
    <Card>
      <Empty description="请先选择盒子并登录管理账号" />
    </Card>
  );
}
function Overview({
  state,
  call,
  selectBox,
}: {
  state: AdminState;
  call: Call;
  selectBox: (id: string) => Promise<void>;
}) {
  const [overview, setOverview] = useState<Row>();
  useEffect(() => {
    setOverview(undefined);
    if (permission(state, "admin_console"))
      void call("overview")
        .then(setOverview)
        .catch(() => {});
  }, [state.sessionId]);
  return (
    <>
      <div className="metric-grid">
        <Card>
          <Statistic
            title="已登记盒子"
            value={state.boxes.length}
            prefix={<BoxIcon size={20} />}
          />
        </Card>
        <Card>
          <Statistic
            title="当前连接"
            value={state.status === "connected" ? "已验证" : "未连接"}
            prefix={<Activity size={20} />}
          />
        </Card>
        <Card>
          <Statistic
            title="产品管理协议"
            value={state.capabilities?.sdk_management?.protocol_version || "—"}
            prefix={<LayoutGrid size={20} />}
          />
        </Card>
        <Card>
          <Statistic
            title="连接身份"
            value="登记待完成"
            prefix={<ShieldCheck size={20} />}
          />
        </Card>
      </div>
      <Card title="我的盒子" extra={<Tag>每次明确操作一台</Tag>}>
        <Table
          rowKey="id"
          pagination={false}
          dataSource={state.boxes}
          columns={[
            {
              title: "盒子",
              dataIndex: "name",
              render: (value) => <strong>{value}</strong>,
            },
            {
              title: "连接入口",
              render: (_, box) => box.baseURL || box.deviceId,
            },
            {
              title: "连接方式",
              render: (_, box) => (
                <Tag>
                  {box.connection === "p2p"
                    ? "远程设备 · 待登记"
                    : "可信 HTTP 适配"}
                </Tag>
              ),
            },
            {
              title: "操作",
              render: (_, box) => (
                <Space>
                  <Button type="link" onClick={() => void selectBox(box.id)}>
                    连接
                  </Button>
                  <Popconfirm
                    title="从本机目录移除此盒子？盒子上的数据保留。"
                    onConfirm={() => call("boxes.remove", { id: box.id })}
                  >
                    <Button type="link" danger>
                      移除登记
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Card title="当前盒子诊断" className="section-card">
        <Descriptions
          column={2}
          items={[
            {
              key: "server",
              label: "服务端版本",
              children: state.capabilities?.server_version || "等待连接",
            },
            {
              key: "transport",
              label: "连接通道",
              children:
                state.box?.connection === "p2p"
                  ? "尚未登记正式远程身份"
                  : state.box
                  ? "主进程 SDK 可信 HTTP 适配"
                  : "等待选择",
            },
            {
              key: "rights",
              label: "有效权限",
              children:
                state.user?.role === "admin"
                  ? "系统管理员"
                  : state.user?.permissions.join("、") || "等待验证",
            },
            {
              key: "protocol",
              label: "产品管理",
              children: state.capabilities?.sdk_management?.applications
                ? "协议可用"
                : "等待能力确认",
            },
          ]}
        />
        {overview && (
          <details>
            <summary>系统运行摘要</summary>
            <pre>{json(overview)}</pre>
          </details>
        )}
      </Card>
    </>
  );
}
const resourceSections = [
  {
    key: "providers",
    name: "模型提供方",
    permission: "providers",
    example: {
      name: "我的模型服务",
      kind: "openai",
      base_url: "https://api.example.com/v1",
      api_key: "",
      models: [{ id: "model-id" }],
    },
  },
  {
    key: "storage",
    name: "存储后端",
    permission: "storage_backends",
    example: { name: "产品存储", kind: "local", endpoint: "", note: "" },
  },
  {
    key: "connectors",
    name: "连接器",
    permission: "connectors",
    example: { servers: {} },
  },
  {
    key: "skills",
    name: "技能包",
    permission: "skill_packages",
    example: { name: "产品技能包", description: "" },
  },
  {
    key: "plugins",
    name: "插件",
    permission: "plugins",
    example: { url: "https://example.com/plugin.zip" },
  },
  { key: "security", name: "安全策略", permission: "security", example: {} },
];
function SystemSettings({ state, call }: { state: AdminState; call: Call }) {
  const available = resourceSections.filter((item) =>
    permission(state, item.permission),
  );
  const [section, setSection] = useState(available[0]?.key || "providers"),
    [rows, setRows] = useState<Row[]>([]),
    [loading, setLoading] = useState(false),
    [editor, setEditor] = useState<{
      operation: string;
      id?: string | number;
      value: string;
    }>();
  const active = resourceSections.find((item) => item.key === section)!;
  const readGuard = useRef(new SelectionGuard());
  readGuard.current.select(`${state.sessionId}:${section}`);
  const refresh = useCallback(async () => {
    if (!available.some((item) => item.key === section)) return;
    const isCurrent = readGuard.current.begin(`${state.sessionId}:${section}`);
    setLoading(true);
    try {
      const data = collection(await call("resource.list", { section }));
      if (isCurrent()) setRows(data);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [call, section, state.sessionId]);
  useEffect(() => {
    setRows([]);
    setEditor(undefined);
    void refresh().catch(() => {});
    return () => readGuard.current.invalidate();
  }, [refresh]);
  if (!available.length) return <NoAccess />;
  const singleton = ["connectors", "security"].includes(section);
  const edit = (row: Row) => {
    const allow: Record<string, string[]> = {
      providers: [
        "kind",
        "base_url",
        "api_key",
        "models",
        "extra_json",
        "note",
        "enabled",
      ],
      storage: [
        "name",
        "kind",
        "endpoint",
        "access_key",
        "secret_key",
        "bucket",
        "region",
        "config_json",
        "note",
        "enabled",
      ],
      skills: ["name", "description", "icon_name", "icon_url"],
      plugins: ["enabled"],
    };
    const value = singleton
      ? row
      : Object.fromEntries(
          Object.entries(row).filter(([key]) => allow[section]?.includes(key)),
        );
    setEditor({
      operation: "update",
      id: row.id ?? row.package_id ?? row.plugin_id,
      value: json(value),
    });
  };
  return (
    <>
      <Tabs
        activeKey={section}
        onChange={setSection}
        items={available.map((item) => ({ key: item.key, label: item.name }))}
      />
      <Card
        title={active.name}
        extra={
          <Space>
            <Button
              icon={<RefreshCw size={15} />}
              onClick={() => void refresh().catch(() => {})}
            >
              刷新
            </Button>
            {!singleton && (
              <Button
                type="primary"
                icon={<Plus size={15} />}
                onClick={() =>
                  setEditor({
                    operation: "create",
                    value: json(active.example),
                  })
                }
              >
                {section === "plugins" ? "安装插件" : "新增"}
              </Button>
            )}
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          message="配置由当前盒子的 WANX 服务端保存。已保存的密钥不会返回管理界面；更换密钥时再填写。"
          className="notice"
        />
        <Table
          rowKey={(row, index) => String(row.id ?? row.name ?? index)}
          loading={loading}
          dataSource={rows}
          pagination={{ pageSize: 8 }}
          columns={[
            {
              title: "名称",
              render: (_, row) => (
                <strong>{row.name || row.id || active.name}</strong>
              ),
            },
            {
              title: "配置",
              render: (_, row) => (
                <div className="compact-code">{json(row)}</div>
              ),
            },
            {
              title: "操作",
              width: 200,
              render: (_, row) => (
                <Space wrap>
                  <Button type="link" onClick={() => edit(row)}>
                    编辑
                  </Button>
                  {["providers", "storage"].includes(section) && (
                    <Button
                      type="link"
                      onClick={() =>
                        void call("resource.test", {
                          section,
                          id: row.id,
                          body: {},
                        })
                          .then((result) => messageResult(result))
                          .catch(() => {})
                      }
                    >
                      测试
                    </Button>
                  )}
                  {!singleton && (
                    <Popconfirm
                      title="移除这项平台资源？关联产品可能受影响。"
                      onConfirm={() =>
                        call("resource.delete", {
                          section,
                          id: row.id ?? row.package_id ?? row.plugin_id,
                        }).then(refresh)
                      }
                    >
                      <Button type="link" danger>
                        移除
                      </Button>
                    </Popconfirm>
                  )}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title={`${editor?.operation === "create" ? "新增" : "编辑"}${
          active.name
        }`}
        width={720}
        open={Boolean(editor)}
        onCancel={() => setEditor(undefined)}
        okText="保存到当前盒子"
        onOk={() => {
          try {
            const body = JSON.parse(editor!.value);
            void call(`resource.${editor!.operation}`, {
              section,
              id: editor!.id,
              body,
            })
              .then(() => {
                setEditor(undefined);
                return refresh();
              })
              .catch(() => {});
          } catch {
            Modal.error({
              title: "JSON 格式无效",
              content: "请检查配置内容后再保存。",
            });
          }
        }}
      >
        <p>
          使用平台原生配置字段。编辑时保留不需要修改的字段，密钥留空字段请移除。
        </p>
        <JsonField
          rows={15}
          value={editor?.value}
          onChange={(value) =>
            setEditor((previous) => ({ ...previous!, value }))
          }
        />
      </Modal>
    </>
  );
}
function messageResult(value: any) {
  Modal.info({
    title: "测试结果",
    content: <pre className="compact-code">{json(value)}</pre>,
  });
}
function Products({ state, call }: { state: AdminState; call: Call }) {
  const { message } = App.useApp();
  const [products, setProducts] = useState<Row[]>([]),
    [selected, setSelected] = useState<string>(),
    [deployment, setDeployment] = useState<Row>(),
    [releases, setReleases] = useState<Row[]>([]),
    [access, setAccess] = useState<Row[]>([]),
    [tab, setTab] = useState("definition"),
    [productModal, setProductModal] = useState(false),
    [editingId, setEditingId] = useState<string>(),
    [releaseModal, setReleaseModal] = useState(false),
    [accessModal, setAccessModal] = useState(false);
  const [productForm] = Form.useForm(),
    [deployForm] = Form.useForm(),
    [releaseForm] = Form.useForm(),
    [accessForm] = Form.useForm();
  const active = products.find(
    (product) => product.application_id === selected,
  );
  const detailGuard = useRef(new SelectionGuard());
  detailGuard.current.select(`${state.sessionId}:${selected}`);
  const load = useCallback(async () => {
    const list = collection(await call("products.list"));
    setProducts(list);
    setSelected((previous) =>
      previous && list.some((product) => product.application_id === previous)
        ? previous
        : list[0]?.application_id,
    );
  }, [call]);
  const detail = useCallback(async () => {
    if (!selected) return;
    const isCurrent = detailGuard.current.begin(
      `${state.sessionId}:${selected}`,
    );
    const results = await Promise.all([
      call("deployment.get", { applicationId: selected }),
      call("releases.list", { applicationId: selected }),
      call("access.list", { applicationId: selected }),
    ]);
    if (!isCurrent()) return;
    setDeployment(results[0]);
    setReleases(collection(results[1]));
    setAccess(collection(results[2]));
    deployForm.setFieldsValue({
      enabled: results[0].enabled,
      resource_bindings: json(results[0].resource_bindings || {}),
      configuration: json(results[0].configuration || {}),
    });
  }, [call, selected, deployForm, state.sessionId]);
  useEffect(() => {
    void load().catch(() => {});
  }, [load]);
  useEffect(() => {
    setDeployment(undefined);
    setReleases([]);
    setAccess([]);
    deployForm.resetFields();
    void detail().catch(() => {});
    return () => detailGuard.current.invalidate();
  }, [detail]);
  const editProduct = (row?: Row) => {
    setEditingId(row?.application_id);
    productForm.resetFields();
    productForm.setFieldsValue(
      row
        ? {
            ...row,
            agent_template: json(row.agent_template || {}),
            resource_requirements: json(row.resource_requirements || {}),
          }
        : {
            application_id: "",
            name: "",
            description: "",
            capabilities: ["memory", "chat"],
            agent_template: "{}",
            resource_requirements: "{}",
          },
    );
    setProductModal(true);
  };
  return (
    <>
      <div className="toolbar">
        <Select
          className="product-select"
          value={selected}
          placeholder="选择产品"
          options={products.map((product) => ({
            value: product.application_id,
            label: `${product.name} · ${product.application_id}`,
          }))}
          onChange={setSelected}
        />
        <Space>
          <Button
            icon={<Upload size={15} />}
            onClick={() =>
              void call("manifest.import")
                .then(load)
                .catch(() => {})
            }
          >
            导入清单
          </Button>
          <Button
            type="primary"
            icon={<Plus size={15} />}
            onClick={() => editProduct()}
          >
            创建产品
          </Button>
        </Space>
      </div>
      {active ? (
        <>
          <Card className="product-hero">
            <div>
              <Tag color="blue">{active.application_id}</Tag>
              <h2>{active.name}</h2>
              <p>{active.description || "基于 WANX 的应用产品"}</p>
              <Space>
                {deployment?.enabled ? (
                  <Tag color="green">本盒已启用</Tag>
                ) : (
                  <Tag>本盒未启用</Tag>
                )}
                <Tag>正式远程身份待登记</Tag>
              </Space>
            </div>
            <Space>
              <Button onClick={() => editProduct(active)}>编辑定义</Button>
              <Button
                icon={<Download size={15} />}
                onClick={() =>
                  void call("manifest.export", { applicationId: selected })
                    .then(
                      (result) => result && message.success("产品清单已导出"),
                    )
                    .catch(() => {})
                }
              >
                导出清单
              </Button>
            </Space>
          </Card>
          <Tabs
            activeKey={tab}
            onChange={setTab}
            items={[
              {
                key: "definition",
                label: "产品定义",
                children: (
                  <Card>
                    <Descriptions
                      column={1}
                      items={[
                        {
                          key: "capabilities",
                          label: "产品能力",
                          children: (active.capabilities || []).map(
                            (value: string) => <Tag key={value}>{value}</Tag>,
                          ),
                        },
                        {
                          key: "template",
                          label: "Agent 模板",
                          children: <pre>{json(active.agent_template)}</pre>,
                        },
                        {
                          key: "requirements",
                          label: "资源要求",
                          children: (
                            <pre>{json(active.resource_requirements)}</pre>
                          ),
                        },
                        {
                          key: "identity",
                          label: "连接身份",
                          children: "登记待完成，P2P 入口保持关闭",
                        },
                      ]}
                    />
                    <Alert
                      type="info"
                      showIcon
                      message="更新产品模板只影响后续新建实例，已有用户私人实例不会被覆盖。"
                    />
                  </Card>
                ),
              },
              {
                key: "deployment",
                label: "盒子部署",
                children: (
                  <Card title="当前盒子的资源绑定">
                    <Form
                      form={deployForm}
                      layout="vertical"
                      onFinish={(values) => {
                        try {
                          void call("deployment.put", {
                            applicationId: selected,
                            body: {
                              enabled: values.enabled,
                              resource_bindings: JSON.parse(
                                values.resource_bindings,
                              ),
                              configuration: JSON.parse(values.configuration),
                            },
                          })
                            .then(() => {
                              void message.success("盒子部署配置已保存");
                              return detail();
                            })
                            .catch(() => {});
                        } catch {
                          void message.error("资源或配置 JSON 格式无效");
                        }
                      }}
                    >
                      <Form.Item
                        label="在本盒启用产品"
                        name="enabled"
                        valuePropName="checked"
                      >
                        <Switch />
                      </Form.Item>
                      <Form.Item
                        label="资源绑定"
                        name="resource_bindings"
                        rules={[{ required: true }]}
                      >
                        <JsonField rows={6} />
                      </Form.Item>
                      <Form.Item
                        label="产品运行配置"
                        name="configuration"
                        rules={[{ required: true }]}
                      >
                        <JsonField rows={6} />
                      </Form.Item>
                      <Alert
                        className="notice"
                        type="warning"
                        showIcon
                        message="停用产品将撤销当前访问；已存在的用户档案继续保留。"
                      />
                      <Button type="primary" htmlType="submit">
                        保存部署配置
                      </Button>
                    </Form>
                  </Card>
                ),
              },
              {
                key: "releases",
                label: "客户端版本",
                children: (
                  <Card
                    title="客户端发布记录"
                    extra={
                      <Button
                        type="primary"
                        onClick={() => {
                          releaseForm.resetFields();
                          releaseForm.setFieldsValue({
                            platform: "macos",
                            arch: "arm64",
                            min_wanx_version: "1.0.0",
                            min_sdk_version: "0.1.0-alpha.2",
                          });
                          setReleaseModal(true);
                        }}
                      >
                        登记新版本
                      </Button>
                    }
                  >
                    <Alert
                      className="notice"
                      type="info"
                      showIcon
                      message="安装包由开发者在外部构建、托管。设置推荐版本后，由最终用户选择下载安装。"
                    />
                    <Table
                      rowKey={(row) =>
                        `${row.version}-${row.platform}-${row.arch}`
                      }
                      dataSource={releases}
                      columns={[
                        { title: "版本", dataIndex: "version" },
                        {
                          title: "适用系统",
                          render: (_, row) => `${row.platform} / ${row.arch}`,
                        },
                        {
                          title: "兼容要求",
                          render: (_, row) =>
                            `WANX ≥ ${row.min_wanx_version} · SDK ≥ ${row.min_sdk_version}`,
                        },
                        {
                          title: "状态",
                          render: (_, row) =>
                            row.recommended ? (
                              <Tag color="green">推荐</Tag>
                            ) : (
                              <Tag>已登记</Tag>
                            ),
                        },
                        {
                          title: "操作",
                          render: (_, row) => (
                            <Button
                              type="link"
                              disabled={row.recommended}
                              onClick={() =>
                                void call("releases.recommend", {
                                  applicationId: selected,
                                  version: row.version,
                                  body: {
                                    platform: row.platform,
                                    arch: row.arch,
                                  },
                                })
                                  .then(detail)
                                  .catch(() => {})
                              }
                            >
                              推荐此版本
                            </Button>
                          ),
                        },
                      ]}
                    />
                  </Card>
                ),
              },
              {
                key: "access",
                label: "用户访问",
                children: (
                  <Card
                    title="产品访问授权"
                    extra={
                      <Button
                        type="primary"
                        onClick={() => {
                          accessForm.resetFields();
                          accessForm.setFieldsValue({ enabled: true });
                          setAccessModal(true);
                        }}
                      >
                        为用户开通
                      </Button>
                    }
                  >
                    <Table
                      rowKey="user_id"
                      dataSource={access}
                      columns={[
                        { title: "用户 ID", dataIndex: "user_id" },
                        {
                          title: "访问状态",
                          render: (_, row) => (
                            <Tag color={row.enabled ? "green" : "default"}>
                              {row.enabled ? "已开通" : "已停用"}
                            </Tag>
                          ),
                        },
                        {
                          title: "更新时间",
                          render: (_, row) =>
                            formatTime(row.updated_at, state.timezone),
                        },
                        {
                          title: "操作",
                          render: (_, row) => (
                            <Button
                              type="link"
                              onClick={() =>
                                void call("access.put", {
                                  applicationId: selected,
                                  userId: row.user_id,
                                  body: { enabled: !row.enabled },
                                })
                                  .then(detail)
                                  .catch(() => {})
                              }
                            >
                              {row.enabled ? "停用访问" : "开通访问"}
                            </Button>
                          ),
                        },
                      ]}
                    />
                    <p className="muted">
                      这里只管理访问和运行元数据，不读取用户记忆、聊天或私人文件。
                    </p>
                  </Card>
                ),
              },
            ]}
          />
        </>
      ) : (
        <Card>
          <Empty description="在当前盒子登记第一个产品，或导入现有知君清单。" />
        </Card>
      )}
      <Modal
        title={editingId ? "编辑产品定义" : "创建产品"}
        open={productModal}
        width={740}
        onCancel={() => setProductModal(false)}
        onOk={() => {
          void productForm
            .validateFields()
            .then(async (values) => {
              const body = {
                ...values,
                agent_template: JSON.parse(values.agent_template),
                resource_requirements: JSON.parse(values.resource_requirements),
              };
              const { application_id, ...patch } = body;
              await call(editingId ? "products.update" : "products.create", {
                applicationId: editingId,
                body: editingId ? patch : body,
              });
              setProductModal(false);
              await load();
              setSelected(body.application_id);
            })
            .catch(() => {});
        }}
      >
        <Form form={productForm} layout="vertical">
          <Space className="notice">
            <Button
              onClick={() => {
                const fields = productForm.getFieldsValue();
                try {
                  const body = {
                    ...fields,
                    agent_template: JSON.parse(fields.agent_template || "{}"),
                    resource_requirements: JSON.parse(
                      fields.resource_requirements || "{}",
                    ),
                  };
                  void call("draft.put", { applicationId: editingId, body })
                    .then(() => message.success("产品定义草稿已保存到本机"))
                    .catch(() => {});
                } catch {
                  void message.error("请先修正草稿中的 JSON 格式");
                }
              }}
            >
              保存本机草稿
            </Button>
            <Button
              onClick={() => {
                void call("draft.get", { applicationId: editingId })
                  .then((draft) => {
                    if (!draft) {
                      void message.info("当前产品没有本机草稿");
                      return;
                    }
                    productForm.setFieldsValue({
                      ...draft.product,
                      agent_template: json(draft.product.agent_template || {}),
                      resource_requirements: json(
                        draft.product.resource_requirements || {},
                      ),
                    });
                    void message.success(
                      "已恢复本机草稿，仍需保存到盒子才生效",
                    );
                  })
                  .catch(() => {});
              }}
            >
              恢复本机草稿
            </Button>
            <span className="muted">按盒子、账号和产品隔离</span>
          </Space>
          <div className="form-columns">
            <Form.Item
              name="application_id"
              label="产品标识"
              rules={[
                { required: true },
                {
                  pattern: /^[a-z][a-z0-9.-]*$/,
                  message: "使用小写字母、数字及 . -",
                },
              ]}
            >
              <Input disabled={Boolean(editingId)} placeholder="zhijun" />
            </Form.Item>
            <Form.Item
              name="name"
              label="产品名称"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
          </div>
          <Form.Item name="description" label="产品说明">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="capabilities" label="WANX 能力">
            <Select
              mode="multiple"
              options={["memory", "chat", "knowledge", "upload", "voice"].map(
                (value) => ({ value, label: value }),
              )}
            />
          </Form.Item>
          <Form.Item
            name="agent_template"
            label="Agent 模板 JSON"
            rules={[{ required: true }]}
          >
            <JsonField rows={5} />
          </Form.Item>
          <Form.Item
            name="resource_requirements"
            label="资源要求 JSON"
            rules={[{ required: true }]}
          >
            <JsonField rows={4} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="登记客户端版本"
        open={releaseModal}
        width={660}
        onCancel={() => setReleaseModal(false)}
        onOk={() => {
          void releaseForm
            .validateFields()
            .then((values) =>
              call("releases.create", {
                applicationId: selected,
                body: { ...values, recommended: false },
              }),
            )
            .then(() => {
              setReleaseModal(false);
              return detail();
            })
            .catch(() => {});
        }}
      >
        <Form form={releaseForm} layout="vertical">
          <Form.Item name="version" label="版本号" rules={[{ required: true }]}>
            <Input placeholder="1.0.0" />
          </Form.Item>
          <div className="form-columns">
            <Form.Item
              name="platform"
              label="系统"
              rules={[{ required: true }]}
            >
              <Select
                options={[
                  { value: "macos", label: "macOS" },
                  { value: "windows", label: "Windows" },
                ]}
              />
            </Form.Item>
            <Form.Item name="arch" label="架构" rules={[{ required: true }]}>
              <Select
                options={[
                  { value: "arm64", label: "ARM64" },
                  { value: "x64", label: "x64" },
                ]}
              />
            </Form.Item>
          </div>
          <Form.Item
            name="url"
            label="安装包下载地址"
            rules={[{ required: true }, { type: "url" }]}
          >
            <Input placeholder="https://downloads.example.com/product-1.0.0.dmg" />
          </Form.Item>
          <Form.Item
            name="sha256"
            label="SHA-256 校验值"
            rules={[
              { required: true },
              {
                pattern: /^[a-fA-F0-9]{64}$/,
                message: "请输入 64 位 SHA-256 十六进制",
              },
            ]}
          >
            <Input />
          </Form.Item>
          <div className="form-columns">
            <Form.Item
              name="min_wanx_version"
              label="最低 WANX 版本"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
            <Form.Item
              name="min_sdk_version"
              label="最低 SDK 版本"
              rules={[{ required: true }]}
            >
              <Input />
            </Form.Item>
          </div>
        </Form>
      </Modal>
      <Modal
        title="开通产品访问"
        open={accessModal}
        onCancel={() => setAccessModal(false)}
        onOk={() => {
          void accessForm
            .validateFields()
            .then((values) =>
              call("access.put", {
                applicationId: selected,
                userId: Number(values.userId),
                body: { enabled: values.enabled },
              }),
            )
            .then(() => {
              setAccessModal(false);
              return detail();
            })
            .catch(() => {});
        }}
      >
        <Form form={accessForm} layout="vertical">
          <Form.Item
            name="userId"
            label="WANX 用户 ID"
            rules={[{ required: true }]}
          >
            <Input type="number" min={1} />
          </Form.Item>
          <Form.Item
            name="enabled"
            label="允许使用当前产品"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
function Development({ call }: { call: Call }) {
  const { message } = App.useApp();
  const [products, setProducts] = useState<Row[]>([]),
    [selected, setSelected] = useState<string>(),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<Row>();
  useEffect(() => {
    void call("products.list")
      .then((data) => {
        const items = collection(data);
        setProducts(items);
        setSelected(items[0]?.application_id);
      })
      .catch(() => {});
  }, [call]);
  return (
    <div className="development-layout">
      <Card title="从产品定义生成 SDK 工程">
        <div className="steps-line">
          <span>01 产品配置</span>
          <ChevronRight size={16} />
          <span>02 工程生成</span>
          <ChevronRight size={16} />
          <span>03 外部开发</span>
          <ChevronRight size={16} />
          <span>04 版本登记</span>
        </div>
        <p>
          选择产品，导出一个可以安装、构建的 TypeScript / React / Electron
          工程，在熟悉的开发工具里实现业务和界面。
        </p>
        <Select
          className="full-width"
          placeholder="选择已登记产品"
          value={selected}
          options={products.map((product) => ({
            value: product.application_id,
            label: product.name,
          }))}
          onChange={setSelected}
        />
        <Divider />
        <Descriptions
          column={1}
          items={[
            {
              key: "connection",
              label: "已包含",
              children: "主进程 SDK 接入、账号登录、盒子地址选择、能力查询",
            },
            {
              key: "native",
              label: "原生能力",
              children: "独立用户实例、WANX 记忆调用示例、客户端版本检查",
            },
            {
              key: "identity",
              label: "远程连接",
              children:
                "正式身份登记前保持关闭，先使用可信 HTTPS / 本机服务验证",
            },
            {
              key: "privacy",
              label: "数据边界",
              children: "工程不包含生产凭据或用户数据",
            },
          ]}
        />
        <Button
          type="primary"
          size="large"
          icon={<Code2 size={19} />}
          disabled={!selected}
          loading={busy}
          onClick={() => {
            setBusy(true);
            void call("project.generate", { applicationId: selected })
              .then((data) => {
                if (data) {
                  setResult(data);
                  void message.success("SDK 工程已生成");
                }
              })
              .catch(() => {})
              .finally(() => setBusy(false));
          }}
        >
          选择目录与 SDK 包，生成工程
        </Button>
        {result && (
          <Alert
            type="success"
            showIcon
            className="form-top"
            message="工程生成完成"
            description={result.directory}
          />
        )}
      </Card>
      <Card title="开发与发布说明">
        <ol className="development-guide">
          <li>在产品中心定义所需能力、资源和 Agent 模板。</li>
          <li>
            准备完整 centaurai-wanx npm tarball，生成器将其复制至工程 vendor
            目录。
          </li>
          <li>进入工程，按 README 安装依赖、连接测试服务并实现应用体验。</li>
          <li>
            在 macOS / Windows 上构建安装包，托管至下载地址并计算 SHA-256。
          </li>
          <li>回到产品中心登记版本和兼容要求，设置推荐版本。</li>
        </ol>
        <Alert
          type="info"
          showIcon
          message="V1 为开发团队提供工程起点，产品业务逻辑在外部开发工具实现。"
        />
      </Card>
    </div>
  );
}
function Desktop({ state, call }: { state: AdminState; call: Call }) {
  const [status, setStatus] = useState<Row>(),
    [mode, setMode] = useState<"view" | "control" | null>(null),
    [error, setError] = useState<string>(),
    [log, setLog] = useState<string>(),
    [geometry, setGeometry] = useState("1920x1080"),
    [text, setText] = useState("");
  const canvas = useRef<HTMLCanvasElement>(null),
    imageGeneration = useRef(0),
    [frameSize, setFrameSize] = useState({ width: 1920, height: 1080 });
  const refresh = useCallback(
    () => call("desktop.status").then(setStatus),
    [call],
  );
  useEffect(() => {
    void refresh().catch(() => {});
    const off = window.wanxAdmin?.onDesktop((frame) => {
      if (frame.type === "frame" && typeof frame.data === "string") {
        const marker = ++imageGeneration.current;
        const image = new Image();
        image.onload = () => {
          if (marker !== imageGeneration.current || !canvas.current) return;
          const width = Number(frame.width),
            height = Number(frame.height);
          if (width < 1 || height < 1 || width > 8192 || height > 8192) return;
          canvas.current.width = width;
          canvas.current.height = height;
          canvas.current.getContext("2d")?.drawImage(image, 0, 0);
          setFrameSize({ width, height });
        };
        image.src = `data:image/jpeg;base64,${frame.data}`;
      }
      if (frame.type === "error") {
        setError(frame.message || "远程桌面连接失败");
        setMode(null);
      }
      if (frame.type === "status" && frame.status === "stopped") {
        ++imageGeneration.current;
        canvas.current
          ?.getContext("2d")
          ?.clearRect(0, 0, canvas.current.width, canvas.current.height);
        setMode(null);
      }
    });
    return () => {
      ++imageGeneration.current;
      off?.();
      void call("desktop.close").catch(() => {});
    };
  }, [call, refresh]);
  const start = (next: "view" | "control") => {
    setError(undefined);
    void call("desktop.open", { mode: next })
      .then(() => setMode(next))
      .catch(() => setMode(null));
  };
  const input = (payload: Row) => {
    if (mode !== "control") return;
    void call("desktop.input", payload).catch(() => setMode(null));
  };
  return (
    <>
      <Card
        title="盒子桌面连接"
        extra={
          <Button
            icon={<RefreshCw size={15} />}
            onClick={() => void refresh().catch(() => {})}
          >
            检查环境
          </Button>
        }
      >
        <Descriptions
          column={3}
          items={[
            {
              key: "platform",
              label: "盒子系统",
              children: status?.platform || "正在检查",
            },
            {
              key: "setup",
              label: "组件状态",
              children: status?.setup_state || "—",
            },
            {
              key: "permission",
              label: "待授权项",
              children: (status?.permissions_needed || []).join("、") || "无",
            },
          ]}
        />
        {status?.reason && (
          <Alert type="warning" message={status.reason} className="notice" />
        )}
        <Space wrap>
          <Button
            type="primary"
            icon={<Monitor size={16} />}
            disabled={!status?.ok || status?.setup_state !== "ready"}
            onClick={() => start("view")}
          >
            查看桌面
          </Button>
          <Popconfirm
            title="进入控制模式将向盒子发送鼠标和键盘输入。继续？"
            onConfirm={() => start("control")}
          >
            <Button
              disabled={!status?.ok || !permission(state, "desktop_control")}
            >
              进入控制模式
            </Button>
          </Popconfirm>
          <Button
            disabled={!mode}
            onClick={() => void call("desktop.close").catch(() => {})}
          >
            结束会话
          </Button>
          {mode && (
            <Tag color={mode === "control" ? "orange" : "blue"}>
              {mode === "control" ? "正在控制" : "只读查看"}
            </Tag>
          )}
        </Space>
      </Card>
      {error && (
        <Alert showIcon type="error" message={error} className="form-top" />
      )}
      <div className="desktop-viewport">
        <canvas
          ref={canvas}
          tabIndex={mode === "control" ? 0 : -1}
          aria-label="WANX 盒子远程桌面"
          onClick={(event) => {
            if (mode !== "control") return;
            canvas.current?.focus();
            const rect = event.currentTarget.getBoundingClientRect();
            input({
              type: "click",
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
              canvas_width: Math.round(rect.width),
              canvas_height: Math.round(rect.height),
              screen_width: frameSize.width,
              screen_height: frameSize.height,
              button: "left",
            });
          }}
          onWheel={(event) => {
            if (mode !== "control") return;
            const rect = event.currentTarget.getBoundingClientRect();
            input({
              type: "scroll",
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
              canvas_width: Math.round(rect.width),
              canvas_height: Math.round(rect.height),
              screen_width: frameSize.width,
              screen_height: frameSize.height,
              delta_x: event.deltaX,
              delta_y: event.deltaY,
            });
          }}
          onKeyDown={(event) => {
            if (mode !== "control") return;
            event.preventDefault();
            input({ type: "keydown", key: event.key });
          }}
          onKeyUp={(event) => {
            if (mode !== "control") return;
            event.preventDefault();
            input({ type: "keyup", key: event.key });
          }}
        />
        {!mode && (
          <div className="desktop-empty">
            <Monitor size={44} />
            <h3>连接盒子桌面</h3>
            <p>默认只读查看，控制需要独立授权。</p>
          </div>
        )}
      </div>
      {mode === "control" && (
        <Card className="section-card">
          <Space.Compact className="full-width">
            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="输入要在远端键入的文字"
            />
            <Button
              disabled={!text}
              onClick={() => {
                input({ type: "type", text });
                setText("");
              }}
            >
              发送文字
            </Button>
          </Space.Compact>
        </Card>
      )}
      {permission(state, "desktop_manage") && (
        <Card title="桌面组件维护" className="section-card">
          <Space wrap>
            <Popconfirm
              title="在当前盒子安装桌面组件？"
              onConfirm={() =>
                call("desktop.maintain", { operation: "install" }).then(
                  (result) => {
                    setLog(result.log);
                    return refresh();
                  },
                )
              }
            >
              <Button>安装组件</Button>
            </Popconfirm>
            <Popconfirm
              title="卸载当前盒子的桌面组件？"
              onConfirm={() =>
                call("desktop.maintain", { operation: "uninstall" }).then(
                  (result) => {
                    setLog(result.log);
                    return refresh();
                  },
                )
              }
            >
              <Button danger>卸载组件</Button>
            </Popconfirm>
            <Select
              value={geometry}
              onChange={setGeometry}
              options={["1280x720", "1920x1080", "2560x1440"].map((value) => ({
                value,
                label: value,
              }))}
            />
            <Button
              disabled={status?.platform !== "linux"}
              onClick={() =>
                void call("desktop.geometry", { geometry })
                  .then(refresh)
                  .catch(() => {})
              }
            >
              设置分辨率
            </Button>
          </Space>
          {log && <pre className="maintenance-log">{log}</pre>}
        </Card>
      )}
    </>
  );
}
function Accounts({ state, call }: { state: AdminState; call: Call }) {
  const [users, setUsers] = useState<Row[]>([]),
    [roles, setRoles] = useState<Row[]>([]),
    [permissions, setPermissions] = useState<Row[]>([]),
    [audit, setAudit] = useState<Row[]>([]),
    [userModal, setUserModal] = useState(false),
    [roleModal, setRoleModal] = useState(false),
    [edited, setEdited] = useState<Row>();
  const [userForm] = Form.useForm(),
    [roleForm] = Form.useForm();
  const loadUsers = useCallback(async () => {
    if (!permission(state, "users")) return;
    const result = await Promise.all([
      call("users.list"),
      call("roles.list"),
      call("permissions.list"),
    ]);
    setUsers(collection(result[0]));
    setRoles(collection(result[1]));
    setPermissions(collection(result[2]));
  }, [call, state.sessionId]);
  useEffect(() => {
    setUsers([]);
    setRoles([]);
    setAudit([]);
    void loadUsers().catch(() => {});
    if (permission(state, "admin_console"))
      void call("audit")
        .then((result) => setAudit(collection(result)))
        .catch(() => {});
  }, [call, loadUsers, state.sessionId]);
  const beginUser = (row?: Row) => {
    setEdited(row);
    userForm.resetFields();
    userForm.setFieldsValue(row || { role: "user", permissions: [] });
    setUserModal(true);
  };
  const roleOptions = roles.map((row) => ({
    value: row.user_role_id || row.id,
    label: row.user_role_name || row.name || row.id,
  }));
  return (
    <>
      <Alert
        showIcon
        type="info"
        className="notice"
        message="账号与授权信息用于维护产品访问。这里不提供私人记忆、聊天正文和文件浏览。"
      />
      <Tabs
        items={[
          {
            key: "users",
            label: "用户",
            children: permission(state, "users") ? (
              <Card
                title="WANX 账号"
                extra={
                  <Button type="primary" onClick={() => beginUser()}>
                    创建账号
                  </Button>
                }
              >
                <Table
                  rowKey="id"
                  dataSource={users}
                  columns={[
                    {
                      title: "用户",
                      render: (_, row) => (
                        <>
                          <strong>{row.display_name || row.username}</strong>
                          <div className="muted">
                            #{row.id} · {row.username}
                          </div>
                        </>
                      ),
                    },
                    { title: "角色", dataIndex: "role" },
                    {
                      title: "状态",
                      render: (_, row) => (
                        <Tag color={row.disabled ? "default" : "green"}>
                          {row.disabled ? "停用" : "正常"}
                        </Tag>
                      ),
                    },
                    {
                      title: "创建时间",
                      render: (_, row) =>
                        formatTime(row.created_at, state.timezone),
                    },
                    {
                      title: "操作",
                      render: (_, row) => (
                        <Space>
                          <Button type="link" onClick={() => beginUser(row)}>
                            编辑权限
                          </Button>
                          <Popconfirm
                            title={
                              row.disabled
                                ? "重新启用账号？"
                                : "停用此账号？用户档案保留。"
                            }
                            onConfirm={() =>
                              call("users.update", {
                                userId: row.id,
                                body: { disabled: !row.disabled },
                              }).then(loadUsers)
                            }
                          >
                            <Button type="link" danger={!row.disabled}>
                              {row.disabled ? "启用" : "停用"}
                            </Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            ) : (
              <NoAccess />
            ),
          },
          {
            key: "roles",
            label: "管理员权限",
            children: permission(state, "users") ? (
              <Card
                title="角色模板"
                extra={
                  <Button
                    onClick={() => {
                      roleForm.resetFields();
                      roleForm.setFieldsValue({ permissions: [] });
                      setRoleModal(true);
                    }}
                  >
                    新增角色
                  </Button>
                }
              >
                <Table
                  rowKey={(row) => row.user_role_id || row.id}
                  dataSource={roles}
                  columns={[
                    {
                      title: "角色",
                      render: (_, row) => row.user_role_name || row.name,
                    },
                    { title: "说明", dataIndex: "description" },
                    {
                      title: "权限",
                      render: (_, row) =>
                        row.is_admin ? (
                          <Tag color="blue">系统管理员</Tag>
                        ) : (
                          (row.permissions || []).map((key: string) => (
                            <Tag key={key}>{key}</Tag>
                          ))
                        ),
                    },
                  ]}
                />
              </Card>
            ) : (
              <NoAccess />
            ),
          },
          {
            key: "audit",
            label: "操作审计",
            children: permission(state, "admin_console") ? (
              <Card
                title="最近 100 条管理记录"
                extra={
                  <Button
                    onClick={() =>
                      void call("audit")
                        .then((result) => setAudit(collection(result)))
                        .catch(() => {})
                    }
                  >
                    刷新
                  </Button>
                }
              >
                <Table
                  rowKey={(row, index) => String(row.id ?? index)}
                  dataSource={audit}
                  columns={[
                    {
                      title: "时间",
                      render: (_, row) =>
                        formatTime(
                          row.created_at || row.timestamp,
                          state.timezone,
                        ),
                    },
                    { title: "操作者", dataIndex: "actor" },
                    { title: "操作", dataIndex: "action" },
                    { title: "对象", dataIndex: "target" },
                  ]}
                />
              </Card>
            ) : (
              <NoAccess />
            ),
          },
        ]}
      />
      <Modal
        title={edited ? "编辑账号与权限" : "创建 WANX 账号"}
        open={userModal}
        width={650}
        onCancel={() => {
          setUserModal(false);
          userForm.resetFields();
        }}
        onOk={() => {
          void userForm
            .validateFields()
            .then((values) => {
              const body = edited
                ? {
                    display_name: values.display_name,
                    role: values.role,
                    permissions: values.permissions,
                  }
                : values;
              return call(edited ? "users.update" : "users.create", {
                userId: edited?.id,
                body,
              });
            })
            .then(() => {
              setUserModal(false);
              userForm.resetFields();
              return loadUsers();
            })
            .catch(() => {});
        }}
      >
        <Form form={userForm} layout="vertical">
          {!edited && (
            <>
              <Form.Item
                name="username"
                label="账号"
                rules={[{ required: true }]}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="password"
                label="初始密码"
                rules={[{ required: true }]}
              >
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <Form.Item name="display_name" label="显示名称">
            <Input />
          </Form.Item>
          <Form.Item name="role" label="角色" rules={[{ required: true }]}>
            <Select
              options={
                roleOptions.length
                  ? roleOptions
                  : [
                      { value: "user", label: "普通使用者" },
                      ...(state.user?.role === "admin"
                        ? [{ value: "admin", label: "系统管理员" }]
                        : []),
                    ]
              }
            />
          </Form.Item>
          <Form.Item name="permissions" label="附加权限">
            <Checkbox.Group
              className="permissions-grid"
              options={permissions.map((row) => ({
                value: row.key,
                label: row.label_zh || row.label || row.key,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="创建角色模板"
        open={roleModal}
        width={650}
        onCancel={() => setRoleModal(false)}
        onOk={() => {
          void roleForm
            .validateFields()
            .then((values) =>
              call("roles.create", { body: { ...values, policies: [] } }),
            )
            .then(() => {
              setRoleModal(false);
              return loadUsers();
            })
            .catch(() => {});
        }}
      >
        <Form form={roleForm} layout="vertical">
          <Form.Item
            name="user_role_name"
            label="角色名称"
            rules={[{ required: true }]}
          >
            <Input placeholder="产品开发者" />
          </Form.Item>
          <Form.Item name="description" label="职责说明">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item name="permissions" label="权限">
            <Checkbox.Group
              className="permissions-grid"
              options={permissions.map((row) => ({
                value: row.key,
                label: row.label_zh || row.label || row.key,
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
