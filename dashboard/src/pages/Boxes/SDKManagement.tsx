import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Select,
  Space,
  Spin,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import { useTranslation } from "react-i18next";
import {
  boxManagementAction as call,
  type BoxManagementAction,
  type BoxManagementState,
  type ConsumerDeviceView,
  type ConsumerClientView,
  type ConsumerOwnershipTransferView,
  type ConsumerSupportSessionView,
  type ConsumerOtaStatus,
} from "../../api/modules/boxManagement";

export default function SDKManagement() {
  const { t } = useTranslation();
  const k = (key: string) => t(`boxManager.${key}`);
  const [state, setState] = useState<BoxManagementState | null>(null);
  const [devices, setDevices] = useState<ConsumerDeviceView[]>([]);
  const [clients, setClients] = useState<ConsumerClientView[]>([]);
  const [transfers, setTransfers] = useState<ConsumerOwnershipTransferView[]>(
    [],
  );
  const [device, setDevice] = useState<ConsumerDeviceView | null>(null);
  const [ota, setOta] = useState<ConsumerOtaStatus | null>(null);
  const [support, setSupport] = useState<ConsumerSupportSessionView[]>([]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [account] = Form.useForm();
  const [transfer] = Form.useForm();
  const [help] = Form.useForm();
  const [reset] = Form.useForm();
  const alive = useRef(true),
    selected = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    void call<BoxManagementState>("state")
      .then((value) => {
        if (alive.current) {
          setState(value);
          if (value.identity)
            void call<ConsumerDeviceView[]>("devices.list")
              .then((rows) => {
                if (alive.current) setDevices(rows);
              })
              .catch(() => {
                if (alive.current) setError(t("boxManager.failed"));
              });
        }
      })
      .catch(() => {
        if (alive.current) setError(t("boxManager.unavailable"));
      });
    return () => {
      alive.current = false;
    };
  }, [t]);
  async function run<T>(
    action: BoxManagementAction,
    input: Record<string, unknown> = {},
    accept?: (value: T) => void,
  ) {
    setBusy(true);
    setError("");
    try {
      const value = await call<T>(action, input);
      if (alive.current) accept?.(value);
      return true;
    } catch (cause) {
      if (alive.current) {
        const code = cause instanceof Error ? cause.message : "";
        setError(
          k(
            /LOGIN_REQUIRED/.test(code)
              ? "loginRequired"
              : /DEVICE_NOT_AUTHORIZED/.test(code)
              ? "notOwner"
              : /UPDATE_UNAVAILABLE/.test(code)
              ? "updateUnavailable"
              : "failed",
          ),
        );
      }
      return false;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function refresh() {
    await run<ConsumerDeviceView[]>("devices.list", {}, setDevices);
  }
  async function login(values: Record<string, unknown>) {
    if (await run<BoxManagementState>("account.login", values, setState)) {
      account.resetFields(["verificationCode"]);
      await refresh();
    }
  }
  async function openDevice(value: ConsumerDeviceView) {
    selected.current = value.deviceId;
    setDevice(value);
    setOta(null);
    setSupport([]);
    transfer.resetFields();
    help.resetFields();
    reset.resetFields();
    await run<ConsumerOtaStatus>(
      "ota.status",
      { deviceId: value.deviceId },
      (result) => {
        if (selected.current === value.deviceId) setOta(result);
      },
    );
  }
  function confirm(
    action: BoxManagementAction,
    input: Record<string, unknown>,
    title: string,
    content: string,
    after?: () => void | Promise<void>,
  ) {
    Modal.confirm({
      title,
      content,
      okText: k("confirm"),
      cancelText: k("cancel"),
      okButtonProps: { danger: action === "factory.reset" },
      async onOk() {
        if (!(await run(action, { ...input, confirmed: true })))
          throw new Error("operation failed");
        void message.success(k("submitted"));
        await after?.();
      },
    });
  }
  const accountCard = (
    <Card title={k("account")}>
      {state?.identity ? (
        <Space wrap>
          <Tag color="green">{k("signedIn")}</Tag>
          <Typography.Text>{state.identity.accountId}</Typography.Text>
          <Button disabled={busy} onClick={() => void refresh()}>
            {k("refresh")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void run("account.logout", {}, () => {
                setState({ ...state, identity: null });
                setDevices([]);
                setClients([]);
                setTransfers([]);
                setDevice(null);
              })
            }
          >
            {k("logout")}
          </Button>
        </Space>
      ) : (
        <>
          <Typography.Paragraph type="secondary">
            {k("accountHelp")}
          </Typography.Paragraph>
          <Form
            form={account}
            layout="vertical"
            style={{ maxWidth: 480 }}
            onFinish={(values) => void login(values)}
          >
            <Form.Item
              name="phone"
              label={k("phone")}
              rules={[{ required: true, pattern: /^1\d{10}$/ }]}
            >
              <Input autoComplete="tel" maxLength={11} />
            </Form.Item>
            <Form.Item
              name="verificationCode"
              label={k("code")}
              rules={[{ required: true, pattern: /^\d{6}$/ }]}
            >
              <Input autoComplete="one-time-code" maxLength={6} />
            </Form.Item>
            <Space>
              <Button
                loading={busy}
                type="primary"
                htmlType="submit"
                disabled={!state?.configured}
              >
                {k("login")}
              </Button>
              <Button
                disabled={busy || !state?.configured}
                onClick={() =>
                  void account
                    .validateFields(["phone"])
                    .then((values) =>
                      run(
                        "account.sendSMS",
                        values,
                        () => void message.success(k("smsSent")),
                      ),
                    )
                }
              >
                {k("sendCode")}
              </Button>
            </Space>
          </Form>
        </>
      )}
    </Card>
  );
  const devicesTab = (
    <>
      <Typography.Paragraph type="secondary">
        {k("devicesHelp")}
      </Typography.Paragraph>
      {accountCard}
      {state?.identity && (
        <Card
          title={k("devices")}
          style={{ marginTop: 20 }}
          extra={
            <Button loading={busy} onClick={() => void refresh()}>
              {k("refresh")}
            </Button>
          }
        >
          <List
            dataSource={devices}
            locale={{ emptyText: <Empty description={k("noDevices")} /> }}
            renderItem={(item) => (
              <List.Item
                actions={[
                  <Button
                    key="manage"
                    onClick={() => void openDevice(item)}
                    disabled={busy}
                  >
                    {k("manage")}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space>
                      {item.deviceName || item.deviceId}
                      <Tag color={item.online ? "green" : "default"}>
                        {k(item.online ? "online" : "offline")}
                      </Tag>
                      {item.updateAvailable && (
                        <Tag color="blue">{k("updateAvailable")}</Tag>
                      )}
                    </Space>
                  }
                  description={
                    <Space wrap>
                      <span>{item.deviceId}</span>
                      <span>
                        {k("version")}: {item.currentVersion || "—"}
                      </span>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      )}
    </>
  );
  const transfersTab = (
    <>
      <Space style={{ marginBottom: 16 }}>
        <Button
          loading={busy}
          disabled={!state?.identity}
          onClick={() =>
            void run<ConsumerOwnershipTransferView[]>(
              "transfers.list",
              {},
              setTransfers,
            )
          }
        >
          {k("refresh")}
        </Button>
      </Space>
      <List
        dataSource={transfers}
        locale={{ emptyText: k("noTransfers") }}
        renderItem={(item) => (
          <List.Item
            actions={
              item.direction === "incoming" && !item.completedAt
                ? [
                    <Button
                      key="accept"
                      disabled={busy}
                      onClick={() =>
                        confirm(
                          "transfers.accept",
                          { transferId: item.transferId },
                          k("acceptTransfer"),
                          k("acceptTransferHelp"),
                          () =>
                            run<ConsumerOwnershipTransferView[]>(
                              "transfers.list",
                              {},
                              setTransfers,
                            ).then(() => {}),
                        )
                      }
                    >
                      {k("acceptTransfer")}
                    </Button>,
                  ]
                : []
            }
          >
            <List.Item.Meta
              title={item.deviceId}
              description={`${k(
                item.direction === "incoming" ? "incoming" : "outgoing",
              )} · ${item.state} · ${item.expiresAt}`}
            />
          </List.Item>
        )}
      />
    </>
  );
  const clientsTab = (
    <>
      <Typography.Paragraph type="secondary">
        {k("clientsHelp")}
      </Typography.Paragraph>
      <Button
        loading={busy}
        disabled={!state?.identity}
        onClick={() =>
          void run<ConsumerClientView[]>("clients.list", {}, setClients)
        }
      >
        {k("refresh")}
      </Button>
      <List
        dataSource={clients}
        locale={{ emptyText: k("noClients") }}
        renderItem={(item) => (
          <List.Item
            actions={
              item.status === "active"
                ? [
                    <Button
                      key="revoke"
                      danger
                      disabled={busy}
                      onClick={() =>
                        confirm(
                          "clients.revoke",
                          { clientId: item.clientId },
                          k("revokeClient"),
                          k("revokeClientHelp"),
                          async () => {
                            if (item.current) {
                              setState((prev) =>
                                prev ? { ...prev, identity: null } : prev,
                              );
                              setDevices([]);
                              setClients([]);
                            } else
                              await run<ConsumerClientView[]>(
                                "clients.list",
                                {},
                                setClients,
                              );
                          },
                        )
                      }
                    >
                      {k("revokeClient")}
                    </Button>,
                  ]
                : []
            }
          >
            <List.Item.Meta
              title={
                <Space>
                  {item.displayName || item.clientId}
                  {item.current && <Tag>{k("currentClient")}</Tag>}
                </Space>
              }
              description={`${item.platform} · ${item.status} · ${
                item.lastSeenAt || item.createdAt
              }`}
            />
          </List.Item>
        )}
      />
    </>
  );
  return (
    <Space direction="vertical" size="large" style={{ width: "100%" }}>
      {error && <Alert type="error" showIcon message={error} />}
      {!state && !error ? (
        <Spin />
      ) : (
        <Tabs
          items={[
            { key: "devices", label: k("devices"), children: devicesTab },
            { key: "transfers", label: k("transfers"), children: transfersTab },
            { key: "clients", label: k("clients"), children: clientsTab },
          ]}
        />
      )}
      <Modal
        title={device?.deviceName || device?.deviceId}
        open={Boolean(device)}
        onCancel={() => {
          selected.current = null;
          setDevice(null);
        }}
        footer={null}
        width={760}
        destroyOnClose
      >
        {device && (
          <Tabs
            items={[
              {
                key: "ota",
                label: k("ota"),
                children: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    <Typography.Text>
                      {k("version")}:{" "}
                      {ota?.device?.currentVersion ||
                        device.currentVersion ||
                        "—"}
                    </Typography.Text>
                    {ota?.device?.blockReason && (
                      <Alert type="warning" message={ota.device.blockReason} />
                    )}
                    {ota?.availableRelease ? (
                      <>
                        <Typography.Text>
                          {k("availableVersion")}:{" "}
                          {ota.availableRelease.version}
                        </Typography.Text>
                        <Button
                          type="primary"
                          disabled={
                            busy ||
                            !device.online ||
                            Boolean(ota.device?.blockReason)
                          }
                          onClick={() =>
                            confirm(
                              "ota.request",
                              { deviceId: device.deviceId },
                              k("upgrade"),
                              k("upgradeHelp"),
                              async () => {
                                await run<ConsumerOtaStatus>(
                                  "ota.status",
                                  { deviceId: device.deviceId },
                                  setOta,
                                );
                              },
                            )
                          }
                        >
                          {k("upgrade")}
                        </Button>
                      </>
                    ) : (
                      <Typography.Text type="secondary">
                        {k("noUpdate")}
                      </Typography.Text>
                    )}
                    <Button
                      loading={busy}
                      onClick={() =>
                        void run<ConsumerOtaStatus>(
                          "ota.status",
                          { deviceId: device.deviceId },
                          setOta,
                        )
                      }
                    >
                      {k("refresh")}
                    </Button>
                    <List
                      dataSource={ota?.updates || []}
                      locale={{ emptyText: k("noUpdates") }}
                      renderItem={(item) => (
                        <List.Item>
                          <List.Item.Meta
                            title={item.targetVersion || item.updateId}
                            description={`${item.status}${
                              item.progressPercent !== undefined
                                ? ` · ${item.progressPercent}%`
                                : ""
                            }`}
                          />
                        </List.Item>
                      )}
                    />
                  </Space>
                ),
              },
              {
                key: "support",
                label: k("support"),
                children: (
                  <>
                    <Typography.Paragraph>
                      {k("supportHelp")}
                    </Typography.Paragraph>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void run<ConsumerSupportSessionView[]>(
                          "support.list",
                          { deviceId: device.deviceId },
                          setSupport,
                        )
                      }
                    >
                      {k("refresh")}
                    </Button>
                    <List
                      dataSource={support}
                      locale={{ emptyText: k("noSupport") }}
                      renderItem={(item) => (
                        <List.Item
                          actions={
                            item.status === "active"
                              ? [
                                  <Button
                                    key="revoke"
                                    disabled={busy}
                                    onClick={() =>
                                      confirm(
                                        "support.revoke",
                                        {
                                          deviceId: device.deviceId,
                                          sessionId: item.sessionId,
                                        },
                                        k("endSupport"),
                                        k("endSupportHelp"),
                                        () =>
                                          run<ConsumerSupportSessionView[]>(
                                            "support.list",
                                            { deviceId: device.deviceId },
                                            setSupport,
                                          ).then(() => {}),
                                      )
                                    }
                                  >
                                    {k("endSupport")}
                                  </Button>,
                                ]
                              : []
                          }
                        >
                          <List.Item.Meta
                            title={item.reason}
                            description={`${item.scopes.join(", ")} · ${
                              item.status
                            } · ${item.expiresAt}`}
                          />
                        </List.Item>
                      )}
                    />
                    <Form
                      form={help}
                      layout="vertical"
                      initialValues={{
                        scopes: ["support.logs"],
                        durationMinutes: 30,
                      }}
                      onFinish={(values) =>
                        confirm(
                          "support.create",
                          { ...values, deviceId: device.deviceId },
                          k("createSupport"),
                          k("createSupportHelp"),
                          async () => {
                            help.resetFields();
                            await run<ConsumerSupportSessionView[]>(
                              "support.list",
                              { deviceId: device.deviceId },
                              setSupport,
                            );
                          },
                        )
                      }
                    >
                      <Form.Item
                        name="scopes"
                        label={k("supportScopes")}
                        rules={[{ required: true }]}
                      >
                        <Select
                          mode="multiple"
                          options={[
                            "support.logs",
                            "support.ssh",
                            "support.vnc",
                          ].map((value) => ({
                            value,
                            label: k(
                              value === "support.logs"
                                ? "logs"
                                : value === "support.ssh"
                                ? "ssh"
                                : "vnc",
                            ),
                          }))}
                        />
                      </Form.Item>
                      <Form.Item
                        name="reason"
                        label={k("reason")}
                        rules={[{ required: true }]}
                      >
                        <Input maxLength={500} />
                      </Form.Item>
                      <Form.Item
                        name="durationMinutes"
                        label={k("duration")}
                        rules={[{ required: true }]}
                      >
                        <InputNumber min={1} max={120} />
                      </Form.Item>
                      <Button htmlType="submit" disabled={busy}>
                        {k("createSupport")}
                      </Button>
                    </Form>
                  </>
                ),
              },
              {
                key: "transfer",
                label: k("transfer"),
                children: (
                  <>
                    <Alert
                      type="warning"
                      showIcon
                      message={k("transferHelp")}
                    />
                    <Form
                      form={transfer}
                      layout="vertical"
                      style={{ marginTop: 20 }}
                      onFinish={(values) =>
                        confirm(
                          "transfers.create",
                          { ...values, deviceId: device.deviceId },
                          k("transfer"),
                          k("transferConfirm"),
                          () => {
                            transfer.resetFields(["verificationCode"]);
                          },
                        )
                      }
                    >
                      <Form.Item
                        name="ownerPhone"
                        label={k("ownerPhone")}
                        rules={[{ required: true, pattern: /^1\d{10}$/ }]}
                      >
                        <Input maxLength={11} />
                      </Form.Item>
                      <Form.Item
                        name="verificationCode"
                        label={k("code")}
                        rules={[{ required: true, pattern: /^\d{6}$/ }]}
                      >
                        <Input maxLength={6} autoComplete="one-time-code" />
                      </Form.Item>
                      <Form.Item
                        name="targetPhone"
                        label={k("targetPhone")}
                        rules={[{ required: true, pattern: /^1\d{10}$/ }]}
                      >
                        <Input maxLength={11} />
                      </Form.Item>
                      <Form.Item name="retainData" valuePropName="checked">
                        <Checkbox>{k("retainData")}</Checkbox>
                      </Form.Item>
                      <Button htmlType="submit" disabled={busy}>
                        {k("transfer")}
                      </Button>
                    </Form>
                  </>
                ),
              },
              {
                key: "reset",
                label: k("factoryReset"),
                children: (
                  <>
                    <Alert type="error" showIcon message={k("resetWarning")} />
                    <Form
                      form={reset}
                      layout="vertical"
                      style={{ marginTop: 20 }}
                      onFinish={(values) =>
                        confirm(
                          "factory.reset",
                          { ...values, deviceId: device.deviceId },
                          k("factoryReset"),
                          k("resetWarning"),
                          () => {
                            reset.resetFields();
                          },
                        )
                      }
                    >
                      <Form.Item
                        name="ownerPhone"
                        label={k("ownerPhone")}
                        rules={[{ required: true, pattern: /^1\d{10}$/ }]}
                      >
                        <Input maxLength={11} />
                      </Form.Item>
                      <Form.Item
                        name="verificationCode"
                        label={k("code")}
                        rules={[{ required: true, pattern: /^\d{6}$/ }]}
                      >
                        <Input maxLength={6} autoComplete="one-time-code" />
                      </Form.Item>
                      <Form.Item
                        name="confirmation"
                        label={k("eraseLabel")}
                        rules={[
                          {
                            required: true,
                            validator: (_, value) =>
                              value === "ERASE"
                                ? Promise.resolve()
                                : Promise.reject(new Error(k("eraseLabel"))),
                          },
                        ]}
                      >
                        <Input autoComplete="off" />
                      </Form.Item>
                      <Button danger htmlType="submit" disabled={busy}>
                        {k("factoryReset")}
                      </Button>
                    </Form>
                  </>
                ),
              },
            ]}
          />
        )}
      </Modal>
    </Space>
  );
}
