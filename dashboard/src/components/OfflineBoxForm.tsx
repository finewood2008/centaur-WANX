import { Button, Form, Input } from "antd";
import { useTranslation } from "react-i18next";
import { clearAuthToken } from "../api/request";
import { normalizeBoxUrl, switchBox } from "../utils/boxConnection";
export default function OfflineBoxForm() {
  const { t } = useTranslation();
  return (
    <Form
      layout="vertical"
      onFinish={({ url }: { url: string }) => switchBox(url, clearAuthToken)}
    >
      <Form.Item
        name="url"
        label={t("boxes.url")}
        rules={[
          { required: true },
          {
            validator: async (_, value: string) => {
              try {
                normalizeBoxUrl(value);
              } catch {
                throw new Error(t("boxes.invalidUrl"));
              }
            },
          },
        ]}
      >
        <Input placeholder="https://wanx.example.com" />
      </Form.Item>
      <Button htmlType="submit">{t("boxes.connect")}</Button>
    </Form>
  );
}
