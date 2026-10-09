# 半人马AI-万象 / CentaurAI-WANX UI

本分支基于 Omnia 仓库的 Octop `v1.0.2b4`，将半人马AI-万象工作台的品牌和视觉样式接入现有 React 界面。

## 界面范围

- 使用半人马AI-万象工作台原始 `centaurai-mark.png` 品牌图，覆盖启动页、侧边栏、移动端页头、登录、初始化、聊天欢迎页和 PWA 图标。
- 新增默认 `centaur` 配色：浅色使用暖纸色背景和陶土色强调，深色使用深蓝背景和金色强调。
- 调整聊天消息、输入框、标题、导航选中态和 Ant Design 控件表面样式。
- 保留深浅模式选择。首次加载时，将旧默认 `rose` 配色迁移为 `centaur`；其他已有配色保持不变，迁移后仍可重新选择任意配色。

视觉参考为 `centaurai-wanx` 的半人马AI-万象工作台设计规范。业务路由、API、身份验证和数据存储继续使用 Octop 原有实现。

## 主要文件

| 文件 | 用途 |
| --- | --- |
| `dashboard/src/styles/themePalettes.ts` | 品牌配色和 Ant Design 主色 |
| `dashboard/src/styles/theme-vars.css` | 深浅主题的语义色值 |
| `dashboard/src/styles/centaur-ui.css` | 半人马AI-万象工作台的界面细节 |
| `dashboard/src/styles/appearanceStorage.ts` | 旧默认配色的一次性迁移 |
| `dashboard/src/layouts/Sidebar.tsx` | 工作台品牌和导航外壳 |
| `dashboard/public/centaurai-mark.png` | 原始品牌图片 |
| `dashboard/index.html` | 首屏、标题、图标和主题预加载 |

## 构建和检查

```sh
cd dashboard
npm ci
npm run build
npx vitest run src/styles/bootTheme.test.ts src/styles/themePalettes.test.ts src/styles/appearanceStorage.test.ts src/utils/expertColor.test.ts
```

Node 25 的实验性 Web Storage 会与当前 jsdom 测试环境冲突；在该版本上运行 Vitest 时设置 `NODE_OPTIONS=--no-experimental-webstorage`。

构建输出位于 `src/octop/dashboard/`。部署时发布整个构建目录，保留原有静态资源备份；回退时恢复该目录并刷新页面。不要手工修改构建产物。

验收时检查浅色/深色、折叠导航、窄屏、登录、聊天空状态和已有会话。桌面客户端需刷新页面后加载新资源。

## 半人马AI-万象 / CentaurAI-WANX 产品命名

- 产品中文名为“半人马AI-万象”，英文名为“CentaurAI-WANX”；半人马人工智能仅作为关于窗口中的出品方署名。继续使用已确认的半人马原始 logo。
- 登录、初始化、导航、聊天、记忆、设置、错误提示、离线页及 PWA 使用同一产品命名。已移除原产品的闲置 logo 和吉祥物资源，离线缓存只预缓存当前品牌图。
- 桌面产物为 `CentaurAI-WANX.app` / `CentaurAI-WANX.exe`，启动页、托盘、系统菜单和打包元数据使用 CentaurAI-WANX。
- 兼容层保留既有 Python 包名、数据库和数据目录、HTTP 头、存储键以及系统应用标识，避免旧账号、会话、权限和数据因改名失联；第三方依赖和原始许可证保留真实来源。
- 此分支尚未配置半人马AI-万象在线发布源。更新页面指向本项目 Codeup 仓库，HTTP 和 CLI 安装入口阻止上游包覆盖；保留独立的服务重启能力。不能将“未配置更新源”显示成“已是最新版”。
- 发布桌面包时同时更新内嵌 portable 压缩包内的后端和 dashboard，确保首次安装也使用当前品牌。
