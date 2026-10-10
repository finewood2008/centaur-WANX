import { useState } from "react";
import { Alert, Button, Form, Input, List, Space, Typography } from "antd";
import { useTranslation } from "react-i18next";
import PageShell from "../../layouts/PageShell";
import { isWanxDesktopClient } from "../../utils/desktopClient";
import { DesktopBoxesPage } from "../DesktopClient";
import { clearAuthToken } from "../../api/request";
import {
  loadBoxes,
  normalizeBoxUrl,
  openNativeBoxChooser,
  saveBoxes,
  switchBox,
} from "../../utils/boxConnection";

export default function BoxesPage() {
  return isWanxDesktopClient() ? <DesktopBoxesPage /> : <DirectBoxesPage />;
}
function DirectBoxesPage() {
  const { t } = useTranslation();
  const [boxes, setBoxes] = useState(loadBoxes);
  const [error, setError] = useState("");
  const [form] = Form.useForm<{ name: string; url: string }>();
  function add({ name, url }: { name: string; url: string }) {
    try {
      const normalized = normalizeBoxUrl(url);
      const next = [
        ...boxes.filter((box) => box.url !== normalized),
        { name: name.trim(), url: normalized },
      ];
      saveBoxes(next);
      setBoxes(next);
      form.resetFields();
      setError("");
    } catch {
      setError(t("boxes.invalidUrl"));
    }
  }
  return (
    <PageShell title={t("boxes.title")} subtitle={t("boxes.subtitle")}>
      <Space direction="vertical" size="large" style={{ width: "100%" }}>
        <Alert
          type="info"
          showIcon
          message={t("boxes.directOnly")}
          description={t("boxes.boundary")}
        />
        <Typography.Text>
          {t("boxes.current")}: {window.location.origin}
        </Typography.Text>
        {error && <Alert type="error" message={error} />}
        <Form
          form={form}
          layout="vertical"
          onFinish={add}
          style={{ maxWidth: 600 }}
        >
          <Form.Item
            name="name"
            label={t("boxes.name")}
            rules={[{ required: true, whitespace: true }]}
          >
            <Input maxLength={80} />
          </Form.Item>
          <Form.Item
            name="url"
            label={t("boxes.url")}
            rules={[{ required: true }]}
          >
            <Input placeholder="https://wanx.example.com" />
          </Form.Item>
          <Button htmlType="submit">{t("boxes.save")}</Button>
        </Form>
        <List
          dataSource={boxes}
          locale={{ emptyText: t("boxes.empty") }}
          renderItem={(box) => (
            <List.Item
              actions={[
                <Button
                  key="open"
                  type="primary"
                  onClick={() => switchBox(box.url, clearAuthToken)}
                >
                  {t("boxes.connect")}
                </Button>,
                <Button
                  key="remove"
                  onClick={() => {
                    const next = boxes.filter((item) => item.url !== box.url);
                    saveBoxes(next);
                    setBoxes(next);
                  }}
                >
                  {t("boxes.remove")}
                </Button>,
              ]}
            >
              <List.Item.Meta title={box.name} description={box.url} />
            </List.Item>
          )}
        />
        <Button
          onClick={() => {
            clearAuthToken();
            openNativeBoxChooser();
          }}
          disabled={!(window as Window & { _wails?: unknown })._wails}
        >
          {t("boxes.nativeDirectory")}
        </Button>
      </Space>
    </PageShell>
  );
}
