# 万象安装引导海报

2026-10-20 使用内置 **image_gen** 生成的三张营销海报。统一暖白、陶土色和柔和材质，主题依次为：

1. [应用](apps-v1.png)：让 AI 融入日常。
2. [空间](space-v1.png)：安放你的文件与资料。
3. [盒子](box-v1.png)：连接你的 AI 底座。

完整生成提示词与输入参考见 [prompts.json](prompts.json)。原始真实客户端截图保留在 `../screenshots/`。海报结合了真实界面参考和生成式场景，是**产品介绍海报**，不能作为未经编辑的产品实机截图使用。

欢迎页可切换、暂停或自动轮播；正在复制文件的安装页也会自动展示这三张海报，每张 5.5 秒。安装进度不由海报播放时间驱动。`preview.html` 为浏览器演示，非 Windows 实机安装截图。

安装页使用 Windows 自带的 `SysAnimate32` 控件，播放三帧无音轨、未压缩 AVI，无需新增运行时、联网或第三方 NSIS 插件。打包输入为已保存的 BMP / AVI，维护人员重新导出素材时才需要 Pillow 和 ffmpeg。按 100% / 150% / 200% 常见缩放准备三个尺寸，运行时选择可容纳的最大尺寸；原生控件不可用或区域过小时保留静态介绍，不影响安装。

该实现按 [Microsoft 动画控件文档](https://learn.microsoft.com/en-us/windows/win32/controls/animation-control-overview) 接入；实际安装、DPI、取消／失败页清理与覆盖升级仍须在 Windows 验证。
