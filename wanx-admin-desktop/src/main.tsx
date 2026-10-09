import React from "react";
import { createRoot } from "react-dom/client";
import { App as AntApp, ConfigProvider } from "antd";
import zhCN from "antd/locale/zh_CN";
import AdminApp from "./App";
import "./style.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: "#355edb",
          borderRadius: 10,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
          colorBgLayout: "#f5f7fa",
        },
      }}
    >
      <AntApp>
        <AdminApp />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
