# 在 Codespaces 里跑万象

1. 在 GitHub 上打开这个仓库 → **Code** → **Codespaces** → **Create codespace on this branch**
2. 等 `npm install` 跑完（首次约两三分钟）
3. 终端里执行：

   ```sh
   npm start
   ```

4. 端口 8788 会自动转发并弹出浏览器。第一屏会让你**填模型 key**
   （在 platform.deepseek.com 申请，形如 `sk-…`）——填完点「验证并保存」，
   它会先验证再存到 `~/.config/wanxiang/config.json`（权限 0600），
   之后就不用再填。

   也可以走环境变量：`export DEEPSEEK_API_KEY=sk-…` 再 `npm start`。

## 能试什么

- **造一个助手**：全程选择题，右栏会实时长出一份 11 节的需求文档
- **进到助手主页**：看它会做什么 → 给它资料（把会议记录之类的粘进去）→
  **让它跑一次** → 拿到一份交付物，能复制、能打印成 PDF、能回头翻
- **跟它聊聊**：万象自己的多轮对话界面——逐字流式、工具卡片、可打断、历史可回放

## 注意

- 助手落盘在 `~/.local/share/wanxiang/apps`，**故意放在仓库之外**：
  运行内核找项目技能时向上找 `.git`，落在仓库里的话所有助手会共享同一个
  `.dsh/skills`，按助手隔离就失效了
- 桌面外壳（`electron/`）依赖 `/proc`、`ss`、x11，只在 Linux 桌面上可用，
  Codespace 里跑不了也用不上
