# 万象 Windows 安装体验

Windows 标准、正式签名、内部测试三种打包入口共用 `wanx-client/shell/installer.nsh` 与 `installer-ui.nsh`，无需在线加载安装素材。

## 页面与行为

- **欢迎页**：围绕「应用、空间、盒子」三个主要板块，展示以真实界面为参考、使用 image_gen 生成的三张统一风格产品海报。每 5.5 秒切换，可上一页、下一页或暂停；继续安装无需等轮播播放完。
- **安装目录**：保留用户选择目录，以及路径长度和 NTFS 权限检查。
- **安装页**：显示 NSIS 实际文件安装进度、当前状态，同时自动轮播三张海报。使用 Windows 原生动画控件播放无音轨、未压缩 AVI，不增加第三方插件或运行时；单张停留 5.5 秒。按可用空间选择三个预导出尺寸之一，控件不可用时显示静态介绍。安装目录安全验证阶段单独提示；不提供按时间伪造的百分比或剩余时间，也不等待轮播播放完才结束安装。
- **完成页**：品牌插图、使用提示和“立即打开万象”。安装失败不会展示成功页。

静默安装和自动更新不弹出轮播，不增加等待时间；现有安装安全检查、签名校验、单用户安装、账号和应用数据保留策略继续有效。没有修改 macOS 打包行为。

## 素材维护

`wanx-client/resources/installer/` 内六张 24 位 BMP、三份尺寸不同的 AVI，以及 `posters/` 内三张 PNG，均须随代码提交。打包无需 Pillow、ffmpeg、在线图片服务或额外字体。维护人员需要重新导出时，安装 Pillow 与 ffmpeg 后执行：

```sh
python wanx-client/tools/generate-installer-assets.py
```

介绍文案使用 Windows 原生控件和微软雅黑 UI 字体。海报源文件、提示词、工具来源见 `wanx-client/resources/installer/posters/README.md` 与 `prompts.json`。它们是生成式营销海报，不是未经编辑的实机截图。真实参考截图的采集来源与可公开性说明见 `screenshots/README.md`，校验和见同目录 `provenance.json`。安装页和完成页使用本地导出的海报素材及品牌 Logo，不在线加载图片。

浏览器轮播预览：`posters/preview.html`，带明确“非实际安装”标识。可验证播放、暂停、顺序切换与循环；不代替 Windows 原生安装器验收。原生实现依据 [Microsoft 动画控件说明](https://learn.microsoft.com/en-us/windows/win32/controls/animation-control-overview) 和 [ACM_PLAY](https://learn.microsoft.com/en-us/windows/win32/controls/acm-play) 接入，资源关闭与停止在离开安装页时处理。

## 验证与发行边界

```sh
node --test wanx-client/tests/installer-artwork.test.mjs wanx-client/tests/client-release-tools.test.mjs
node wanx-client/tools/verify-installer-ui.mjs
```

第二条使用 electron-builder 所固定的 NSIS 编译器，检查安装、卸载脚本与图片是否能编译。首次执行会下载有校验和的构建工具。输出是**编译检查用的夹具，不是万象安装包，不用于分发**。

发行仍使用原 Windows 打包流程。正式版继续要求 Authenticode 签名与发行信任文件；内部未签名包不能冒充正式版。

Windows 实机验收须另行覆盖：首次安装、原版本覆盖升级、手动返回目录页、欢迎页轮播／暂停、取消安装、静默安装、失败提示、卸载保留数据，以及 100%／150%／200% 缩放与键盘导航。仅通过 NSIS 编译不能视为这些实机验收已通过。

### 2026-10-20 本机验证

- `make all PYTEST_JOBS=2`：格式、Ruff、mypy 通过；4,841 项通过，17 项跳过。
- 基于 CodeUp `master` 的 `709224e` 整理提交后，客户端完整 Node 回归：1,434 项通过，11 项跳过。
- 安装／卸载 NSIS 夹具：两者均编译通过，包含实际 UI 脚本与 BMP 素材。
- 海报接入后另行检查：AVI 为 24 位 BI_RGB、正向底部行存储、三帧、无音轨、单张 5.5 秒；三种尺寸均完成结构检查，解码首帧确认方向正常。浏览器预览已确认上一张、下一张、暂停与恢复播放。
- Windows 实机安装、覆盖升级、DPI 与签名发行：本次未验证，也未生成供分发的新版客户端安装包。
