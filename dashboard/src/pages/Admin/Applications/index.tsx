import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
} from "antd";
import { useTranslation } from "react-i18next";
import PageShell from "../../../layouts/PageShell";
import {
  createApplicationsSession,
  reportApplicationError,
  type ApplicationProduct,
  type ApplicationDeployment,
  type ClientRelease,
  type ClientReleaseInput,
  type ApplicationAccess,
  type ProductDefinition,
} from "../../../api/modules/applications";
import { octopSettingsApi } from "../../../api/modules/settings";
import { useCurrentUser } from "../../../hooks/useCurrentUser";
import { userCan } from "../../../utils/permissions";
import { currentBoxScope } from "../../../utils/desktopClient";
import {
  applicationProjectZip,
  assertCredentialFree,
  downloadFile,
  draftKey,
  parseManifest,
  productDefinition,
} from "./project";

const emptyDefinition: ProductDefinition = {
  application_id: "",
  name: "",
  description: "",
  capabilities: ["chat", "memory"],
  agent_template: {},
  resource_requirements: {},
};
const emptyDeployment: ApplicationDeployment = {
  application_id: "",
  updated_at: 0,
  enabled: false,
  resource_bindings: {},
  configuration: {},
};
const json = (value: unknown) => JSON.stringify(value, null, 2);
function parseObject(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("JSON_OBJECT_REQUIRED");
  assertCredentialFree(value);
  return value as Record<string, unknown>;
}

export default function ApplicationsPage() {
  const { t } = useTranslation();
  const user = useCurrentUser();
  const client = useMemo(createApplicationsSession, []);
  const [products, setProducts] = useState<readonly ApplicationProduct[]>([]);
  const [selected, setSelected] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(
    () => () => {
      void client.close();
    },
    [client],
  );
  useEffect(() => {
    let disposed = false;
    void octopSettingsApi
      .capabilities()
      .then(async (capabilities) => {
        const allowed =
          capabilities.sdk_management?.applications === true &&
          capabilities.sdk_management.protocol_version === 1;
        if (!disposed) setSupported(allowed);
        if (allowed) {
          const response = await client.applications.list();
          if (!disposed) setProducts(response.body);
        }
      })
      .catch((err) => {
        if (!disposed) setError(reportApplicationError(err));
      })
      .finally(() => {
        if (!disposed) setLoaded(true);
      });
    return () => {
      disposed = true;
    };
  }, [client]);
  const current = products.find(
    (product) => product.application_id === selected,
  );
  async function importProduct(file: File) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const manifest = parseManifest(await file.text());
      const response = await client.applications.create(manifest.product);
      setProducts((old) => [...old, response.body]);
      setSelected(response.body.application_id);
      try {
        await client.applications.putDeployment(
          response.body.application_id,
          manifest.deployment,
        );
      } catch (err) {
        throw new Error(
          `${t("applications.partialImport")} ${reportApplicationError(err)}`,
        );
      }
      setNotice(t("applications.importedDisabled"));
    } catch (err) {
      setError(reportApplicationError(err));
    } finally {
      setBusy(false);
    }
  }
  const create = () => {
    setSelected("");
    setNotice("");
    setError("");
  };
  return (
    <PageShell
      title={t("applications.title")}
      subtitle={t("applications.subtitle")}
      actions={
        <Space>
          <Button disabled={busy || !supported} onClick={create}>
            {t("applications.create")}
          </Button>
          <label>
            <Button
              disabled={busy || !supported}
              onClick={() =>
                document.getElementById("application-import")?.click()
              }
            >
              {t("applications.import")}
            </Button>
            <input
              id="application-import"
              type="file"
              accept=".json,application/json"
              hidden
              disabled={busy || !supported}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importProduct(file);
                event.target.value = "";
              }}
            />
          </label>
        </Space>
      }
    >
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert showIcon type="info" message={t("applications.boundary")} />
        {error && <Alert type="error" message={error} />}
        {notice && <Alert type="success" message={notice} />}
        {loaded && supported === false && (
          <Alert type="warning" message={t("applications.unsupported")} />
        )}
        <Select
          style={{ width: "100%" }}
          loading={!loaded}
          disabled={busy}
          value={selected || undefined}
          placeholder={t("applications.select")}
          options={products.map((product) => ({
            value: product.application_id,
            label: `${product.name} · ${product.application_id}`,
          }))}
          onChange={setSelected}
        />
        {supported && user && (
          <ProductEditor
            key={selected || "new"}
            product={current}
            client={client}
            userId={user.id}
            canGrant={
              userCan(user, "applications_manage") ||
              userCan(user, "applications_develop")
            }
            onSaved={(product) => {
              setProducts((old) => [
                ...old.filter(
                  (item) => item.application_id !== product.application_id,
                ),
                product,
              ]);
              setSelected(product.application_id);
            }}
          />
        )}
      </Space>
    </PageShell>
  );
}

function ProductEditor({
  product,
  client,
  userId,
  canGrant,
  onSaved,
}: {
  product?: ApplicationProduct;
  client: ReturnType<typeof createApplicationsSession>;
  userId: number;
  canGrant: boolean;
  onSaved: (product: ApplicationProduct) => void;
}) {
  const { t } = useTranslation();
  const id = product?.application_id || "";
  const api = client.applications;
  const [form] = Form.useForm();
  const [releaseForm] = Form.useForm<ClientReleaseInput>();
  const [accessForm] = Form.useForm<{ user_id: number; enabled: boolean }>();
  const [deployment, setDeployment] = useState(emptyDeployment);
  const [bindings, setBindings] = useState("{}");
  const [configuration, setConfiguration] = useState("{}");
  const [releases, setReleases] = useState<readonly ClientRelease[]>([]);
  const [access, setAccess] = useState<readonly ApplicationAccess[]>([]);
  const [ready, setReady] = useState(!id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sdkFile, setSdkFile] = useState<File | null>(null);
  const [sdkHash, setSdkHash] = useState("");
  // A keyed editor unmount plus an abort signal prevents A's reply filling B's form.
  const lifetime = useRef(new AbortController());
  const desktopSession = useRef(window.wanxDesktop?.sessionToken());
  useEffect(() => {
    lifetime.current = new AbortController();
    return () => lifetime.current.abort();
  }, []);
  useEffect(() => {
    const controller = lifetime.current;
    form.setFieldsValue({
      ...(product || emptyDefinition),
      agent_template: json(product?.agent_template || {}),
      resource_requirements: json(product?.resource_requirements || {}),
    });
    if (!id) return;
    setReady(false);
    void Promise.all([
      api.getDeployment(id, { signal: controller.signal }),
      api.listReleases(id, { signal: controller.signal }),
      api.listAccess(id, { signal: controller.signal }),
    ])
      .then(([dep, versions, grants]) => {
        if (controller.signal.aborted) return;
        setDeployment(dep.body);
        setBindings(json(dep.body.resource_bindings));
        setConfiguration(json(dep.body.configuration));
        setReleases(versions.body);
        setAccess(grants.body);
        setReady(true);
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError(reportApplicationError(err));
      });
  }, [api, id, product, form, lifetime]);
  async function run(
    work: () => Promise<void>,
    noticeKey = "applications.saved",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      if (!lifetime.current.signal.aborted) setNotice(t(noticeKey));
    } catch (err) {
      if (!lifetime.current.signal.aborted)
        setError(reportApplicationError(err));
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }
  function definition(): ProductDefinition {
    const values = form.getFieldsValue();
    return {
      ...productDefinition(values),
      agent_template: parseObject(values.agent_template),
      resource_requirements: parseObject(
        values.resource_requirements,
      ) as ProductDefinition["resource_requirements"],
    };
  }
  async function saveDefinition() {
    await form.validateFields();
    const value = definition();
    const { application_id, ...patch } = value;
    const result = id
      ? await api.update(id, patch, { signal: lifetime.current.signal })
      : await api.create(
          { ...value, application_id },
          { signal: lifetime.current.signal },
        );
    if (!lifetime.current.signal.aborted) onSaved(result.body);
  }
  const disabled = busy || !ready;
  return (
    <Space direction="vertical" size="middle" style={{ width: "100%" }}>
      {error && <Alert type="error" message={error} />}
      {notice && <Alert type="success" message={notice} />}
      <Tabs
        items={[
          {
            key: "definition",
            label: t("applications.definition"),
            children: (
              <Form form={form} layout="vertical" disabled={busy}>
                <Form.Item
                  name="application_id"
                  label={t("applications.id")}
                  rules={[
                    { required: true },
                    {
                      pattern: /^[a-z][a-z0-9.-]{0,63}$/,
                      message: t("applications.invalidId"),
                    },
                  ]}
                >
                  <Input
                    disabled={Boolean(id)}
                    maxLength={64}
                    placeholder="zhijun"
                  />
                </Form.Item>
                <Form.Item
                  name="name"
                  label={t("applications.name")}
                  rules={[{ required: true, whitespace: true }]}
                >
                  <Input maxLength={100} />
                </Form.Item>
                <Form.Item
                  name="description"
                  label={t("applications.description")}
                >
                  <Input.TextArea rows={2} maxLength={4000} />
                </Form.Item>
                <Form.Item
                  name="capabilities"
                  label={t("applications.capabilities")}
                >
                  <Checkbox.Group
                    options={[
                      "chat",
                      "memory",
                      "knowledge",
                      "upload",
                      "voice",
                    ].map((value) => ({
                      value,
                      label: t(`applications.capability.${value}`),
                    }))}
                  />
                </Form.Item>
                <Form.Item
                  name="agent_template"
                  label={t("applications.template")}
                  extra={t("applications.templateHint")}
                >
                  <Input.TextArea rows={5} />
                </Form.Item>
                <Form.Item
                  name="resource_requirements"
                  label={t("applications.requirements")}
                  extra={t("applications.requirementsHint")}
                >
                  <Input.TextArea rows={4} />
                </Form.Item>
                <Space wrap>
                  <Button
                    type="primary"
                    disabled={disabled}
                    onClick={() => void run(saveDefinition)}
                  >
                    {t("applications.saveDefinition")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const value = definition();
                        assertCredentialFree(value);
                        if (window.wanxDesktop) {
                          await window.wanxDesktop.action("draft.put", {
                            sessionId: desktopSession.current,
                            applicationId: id || "new",
                            value,
                          });
                        } else {
                          localStorage.setItem(
                            draftKey(currentBoxScope(), userId, id || "new"),
                            json(value),
                          );
                        }
                      }, "applications.draftSaved")
                    }
                  >
                    {t("applications.saveDraft")}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        let value: ProductDefinition;
                        if (window.wanxDesktop) {
                          const draft = (await window.wanxDesktop.action(
                            "draft.get",
                            {
                              sessionId: desktopSession.current,
                              applicationId: id || "new",
                            },
                          )) as { product: ProductDefinition } | null;
                          if (!draft || lifetime.current.signal.aborted) return;
                          value = draft.product;
                        } else {
                          const raw = localStorage.getItem(
                            draftKey(currentBoxScope(), userId, id || "new"),
                          );
                          if (!raw) return;
                          value = JSON.parse(raw) as ProductDefinition;
                        }
                        assertCredentialFree(value);
                        form.setFieldsValue({
                          ...value,
                          application_id: id || value.application_id,
                          agent_template: json(value.agent_template),
                          resource_requirements: json(
                            value.resource_requirements,
                          ),
                        });
                      })
                    }
                  >
                    {t("applications.restoreDraft")}
                  </Button>
                </Space>
              </Form>
            ),
          },
          ...(id
            ? [
                {
                  key: "deployment",
                  label: t("applications.deployment"),
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Alert
                        type="info"
                        message={t("applications.disableHint")}
                      />
                      <span>
                        {t("applications.enabled")}{" "}
                        <Switch
                          disabled={disabled}
                          checked={deployment.enabled}
                          onChange={(enabled) =>
                            setDeployment((old) => ({ ...old, enabled }))
                          }
                        />
                      </span>
                      <label>
                        {t("applications.bindings")}
                        <Input.TextArea
                          disabled={disabled}
                          value={bindings}
                          rows={5}
                          onChange={(event) => setBindings(event.target.value)}
                        />
                      </label>
                      <label>
                        {t("applications.configuration")}
                        <Input.TextArea
                          disabled={disabled}
                          value={configuration}
                          rows={4}
                          onChange={(event) =>
                            setConfiguration(event.target.value)
                          }
                        />
                      </label>
                      <Button
                        type="primary"
                        disabled={disabled}
                        onClick={() =>
                          void run(async () => {
                            const result = await api.putDeployment(
                              id,
                              {
                                enabled: deployment.enabled,
                                resource_bindings: parseObject(
                                  bindings,
                                ) as Record<string, string>,
                                configuration: parseObject(configuration),
                              },
                              { signal: lifetime.current.signal },
                            );
                            if (!lifetime.current.signal.aborted)
                              setDeployment(result.body);
                          })
                        }
                      >
                        {t("applications.saveDeployment")}
                      </Button>
                    </Space>
                  ),
                },
                {
                  key: "versions",
                  label: t("applications.versions"),
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Alert
                        type="info"
                        message={t("applications.versionHint")}
                      />
                      <Table
                        rowKey={(row) =>
                          `${row.version}:${row.platform}:${row.arch}`
                        }
                        dataSource={[...releases]}
                        pagination={false}
                        columns={[
                          {
                            title: t("applications.version"),
                            dataIndex: "version",
                          },
                          {
                            title: t("applications.platform"),
                            render: (_, row: ClientRelease) =>
                              `${row.platform} / ${row.arch}`,
                          },
                          {
                            title: t("applications.compatibility"),
                            render: (_, row: ClientRelease) =>
                              `WANX ≥ ${row.min_wanx_version} · SDK ≥ ${row.min_sdk_version}`,
                          },
                          {
                            title: t("applications.recommended"),
                            render: (_, row: ClientRelease) =>
                              row.recommended ? (
                                <Tag color="green">
                                  {t("applications.recommended")}
                                </Tag>
                              ) : (
                                <Button
                                  disabled={disabled}
                                  onClick={() =>
                                    void run(async () => {
                                      await api.recommendRelease(
                                        id,
                                        row.version,
                                        {
                                          platform: row.platform,
                                          arch: row.arch,
                                        },
                                        { signal: lifetime.current.signal },
                                      );
                                      const reply = await api.listReleases(id, {
                                        signal: lifetime.current.signal,
                                      });
                                      if (!lifetime.current.signal.aborted)
                                        setReleases(reply.body);
                                    })
                                  }
                                >
                                  {t("applications.recommend")}
                                </Button>
                              ),
                          },
                        ]}
                      />
                      <Form
                        form={releaseForm}
                        layout="vertical"
                        disabled={disabled}
                        initialValues={{
                          platform: "macos",
                          arch: "arm64",
                          min_wanx_version: "1.0.2b4",
                          min_sdk_version: "0.1.0-alpha.3",
                          recommended: false,
                        }}
                      >
                        <Form.Item
                          name="version"
                          label={t("applications.version")}
                          rules={[{ required: true }]}
                        >
                          <Input placeholder="1.0.0" />
                        </Form.Item>
                        <Form.Item
                          name="platform"
                          label={t("applications.platform")}
                        >
                          <Select
                            options={[
                              { value: "macos", label: "macOS" },
                              { value: "windows", label: "Windows" },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item name="arch" label={t("applications.arch")}>
                          <Select
                            options={[
                              { value: "arm64", label: "arm64" },
                              { value: "x64", label: "x64" },
                            ]}
                          />
                        </Form.Item>
                        <Form.Item
                          name="url"
                          label={t("applications.downloadUrl")}
                          rules={[{ required: true }]}
                        >
                          <Input placeholder="https://downloads.example.com/product.zip" />
                        </Form.Item>
                        <Form.Item
                          name="sha256"
                          label="SHA-256"
                          rules={[
                            { required: true },
                            { pattern: /^[a-fA-F0-9]{64}$/ },
                          ]}
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name="min_wanx_version"
                          label={t("applications.minWanx")}
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name="min_sdk_version"
                          label={t("applications.minSdk")}
                          rules={[{ required: true }]}
                        >
                          <Input />
                        </Form.Item>
                        <Form.Item
                          name="recommended"
                          label={t("applications.recommended")}
                          valuePropName="checked"
                        >
                          <Switch />
                        </Form.Item>
                        <Button
                          disabled={disabled}
                          onClick={() =>
                            void run(async () => {
                              const values = await releaseForm.validateFields();
                              const response = await api.createRelease(
                                id,
                                values,
                                { signal: lifetime.current.signal },
                              );
                              if (!lifetime.current.signal.aborted) {
                                setReleases((old) => [...old, response.body]);
                                releaseForm.resetFields();
                              }
                            })
                          }
                        >
                          {t("applications.registerVersion")}
                        </Button>
                      </Form>
                    </Space>
                  ),
                },
                {
                  key: "access",
                  label: t("applications.access"),
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Table
                        rowKey="user_id"
                        dataSource={[...access]}
                        pagination={false}
                        columns={[
                          {
                            title: t("applications.user"),
                            dataIndex: "username",
                          },
                          {
                            title: t("applications.userId"),
                            dataIndex: "user_id",
                          },
                          {
                            title: t("applications.enabled"),
                            render: (_, row: ApplicationAccess) => (
                              <Switch
                                checked={row.enabled}
                                disabled={disabled || !canGrant}
                                onChange={(enabled) =>
                                  void run(async () => {
                                    const response = await api.putAccess(
                                      id,
                                      { user_id: row.user_id, enabled },
                                      { signal: lifetime.current.signal },
                                    );
                                    if (!lifetime.current.signal.aborted)
                                      setAccess((old) =>
                                        old.map((item) =>
                                          item.user_id === row.user_id
                                            ? response.body
                                            : item,
                                        ),
                                      );
                                  })
                                }
                              />
                            ),
                          },
                        ]}
                      />
                      {canGrant && (
                        <Form
                          form={accessForm}
                          layout="inline"
                          disabled={disabled}
                          initialValues={{ enabled: true }}
                        >
                          <Form.Item
                            name="user_id"
                            label={t("applications.userId")}
                            rules={[{ required: true }]}
                          >
                            <InputNumber min={1} precision={0} />
                          </Form.Item>
                          <Form.Item name="enabled" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                          <Button
                            disabled={disabled}
                            onClick={() =>
                              void run(async () => {
                                const values =
                                  await accessForm.validateFields();
                                const response = await api.putAccess(
                                  id,
                                  values,
                                  { signal: lifetime.current.signal },
                                );
                                if (!lifetime.current.signal.aborted)
                                  setAccess((old) => [
                                    ...old.filter(
                                      (item) => item.user_id !== values.user_id,
                                    ),
                                    response.body,
                                  ]);
                              })
                            }
                          >
                            {t("applications.grant")}
                          </Button>
                        </Form>
                      )}
                    </Space>
                  ),
                },
                {
                  key: "development",
                  label: t("applications.development"),
                  children: (
                    <Space direction="vertical" style={{ width: "100%" }}>
                      <Alert
                        type="warning"
                        message={t("applications.identityPending")}
                        description={t("applications.projectHint")}
                      />
                      <Button
                        disabled={disabled}
                        onClick={() =>
                          void run(async () => {
                            const response = await api.getManifest(id, {
                              signal: lifetime.current.signal,
                            });
                            if (!lifetime.current.signal.aborted)
                              downloadFile(
                                `${id}.manifest.json`,
                                new Blob([json(response.body)], {
                                  type: "application/json",
                                }),
                              );
                          })
                        }
                      >
                        {t("applications.export")}
                      </Button>
                      <Card title={t("applications.sdkPackage")}>
                        <input
                          type="file"
                          accept=".tgz"
                          disabled={disabled}
                          onChange={(event) => {
                            setSdkFile(event.target.files?.[0] || null);
                            setSdkHash("");
                          }}
                        />
                        <Form.Item
                          label={t("applications.sdkHash")}
                          htmlFor="application-sdk-checksum"
                        >
                          <Input
                            disabled={disabled}
                            id="application-sdk-checksum"
                            value={sdkHash}
                            onChange={(event) =>
                              setSdkHash(
                                event.target.value.trim().toLowerCase(),
                              )
                            }
                          />
                        </Form.Item>
                        <Button
                          type="primary"
                          disabled={
                            disabled ||
                            !sdkFile ||
                            !/^[a-f0-9]{64}$/.test(sdkHash)
                          }
                          onClick={() =>
                            void run(async () => {
                              if (!sdkFile) return;
                              const bytes = await sdkFile.arrayBuffer();
                              const digest = Array.from(
                                new Uint8Array(
                                  await crypto.subtle.digest("SHA-256", bytes),
                                ),
                                (byte) => byte.toString(16).padStart(2, "0"),
                              ).join("");
                              if (digest !== sdkHash)
                                throw new Error(t("applications.hashMismatch"));
                              const response = await api.getManifest(id, {
                                signal: lifetime.current.signal,
                              });
                              const blob = await applicationProjectZip(
                                response.body,
                                new Blob([bytes]),
                              );
                              if (!lifetime.current.signal.aborted)
                                downloadFile(`${id}-sdk-project.zip`, blob);
                            })
                          }
                        >
                          {t("applications.generate")}
                        </Button>
                      </Card>
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
    </Space>
  );
}
