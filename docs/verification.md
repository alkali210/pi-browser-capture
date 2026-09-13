# 验证记录

验证环境：Windows，Node.js 24，Pi 0.84.2；2026-09-13 至 2026-09-14。本记录区分真实运行时验证与仍需人工覆盖的场景。

## 自动测试

执行 `npm run check`，先进行 TypeScript 检查和构建，再执行 Node 测试。

- DOM：范围筛选、脚本 / 隐藏节点 / 密码值过滤、开放 Shadow DOM、大小限制。
- 协议：裁剪坐标、分数缩放、几何与标识校验、登录状态 origin 约束。
- 文件：截图和 DOM 持久化、登录原值独立保存、标记删除、去重、跨会话拒绝和删除路径检查。
- WebSocket：真实 TCP / WebSocket 连接，扩展 Origin、配对令牌、版本校验、确认与重试、多实例端口分配和会话切换拒绝。
- Pi SDK：通过本地包清单实际发现并加载构建产物；绑定 TUI 接口后检查草稿追加、已有图片合并、idle / steer / followUp 输入及重载。使用隔离用户目录，不调用模型。

## 浏览器运行验证

| 环境 | 已验证 |
| --- | --- |
| Chromium（Playwright 安装的完整 Chromium，非 branded Chrome） | 加载实际扩展、令牌配对与会话发现、真实鼠标框选和元素点选、1.5 倍像素密度裁剪、预览 UI、填写提示词、点击发送、Pi 草稿保留及提交时图片转换 |
| Microsoft Edge | 加载实际扩展、配对、真实鼠标框选、预览 UI、填写提示词、点击发送、Pi 收到附件 |
| Firefox（Playwright Firefox） | 临时安装成功且无 manifest 警告；后台运行、WebSocket 配对 / 发现、真实鼠标框选、PNG 裁剪和 DOM 采集、附件投递及 Pi 提交时图片转换 |

Chromium 登录状态测试使用本地页面的合成数据：成功保存 1 个 HttpOnly Cookie、1 个 localStorage 键和 1 个 sessionStorage 键；提交后的文本没有包含这些原始凭据值。

Firefox 的 `moz-extension:` 页面无法由本机 Playwright 直接操控，改用 Firefox 自带远程调试接口检查扩展并调用扩展 UI 的消息接口。框选操作仍由 Playwright 在真实网页中执行；测试用调试接口授予隔离标签页 activeTab 权限。因此 Firefox 的系统级工具栏、快捷键、权限弹窗和预览按钮尚未做完整人工点击验收。Chromium 测试通过 CDP 触发扩展 action，再启动选取；不是 OS 级快捷键测试。

浏览器测试调用 `scripts/fixture-server.ts` 启动真实 Pi SDK 扩展运行时，并用内存 UI 适配器记录草稿。尚未进行人工终端键入或真实模型请求；图片合并是在实际 Pi 扩展 `input` 管线中核验的。

## 后续人工验收清单

- 在日常 Chrome / Edge / Firefox 窗口中点击工具栏按钮和快捷键，确认弹窗尺寸、焦点与 Escape 取消。
- 在 Firefox 中交互授权 Cookie / 站点权限，验证容器标签页、隐私窗口、分区 Cookie；普通 Chrome / Firefox 的最低支持版本尚未逐一测试。
- 对登录权限拒绝、后台强制回收、页面自动刷新、缩放 / 滚动、大型 DOM、跨域 iframe、封闭 Shadow DOM、canvas 和视频逐项检查提示与降级。
- 打开多个真实终端 Pi 会话，切换 / 重载 / 退出，核对会话选择和输入焦点；使用视觉模型人工确认图片质量。

本地截图、浏览器日志、临时配置与合成附件均位于被 Git 忽略的 `output/playwright/`，不随 npm 包分发。
