# Pi Browser Capture

把浏览器里选中的区域直接添加到 **Pi 终端输入框**：截图、范围内 DOM、页面信息和附加提示词一起进入草稿，提交时截图作为真正的图片发送。

支持 Chrome / Edge 和 Firefox。本机多个 Pi 进程可以同时在线，浏览器端选择接收会话。没有独立桥接服务。

## 安装

需要 Node.js 22+、Pi 0.84.2–0.84.x，以及 Chrome / Edge 116+ 或 Firefox 128+。已针对 Pi 0.84.2 验证。第一版为本机终端扩展，不接入 RPC 图形客户端或远程 Pi。

在仓库目录运行：

```sh
npm ci
npm run check
pi install .
```

`pi install .` 注册此本地包，之后启动 Pi 会自动加载。已有 Pi 窗口可执行 `/reload`。保持本地仓库的位置不变；移动后重新注册路径。

浏览器安装：

| 浏览器 | 开发者加载方式 |
| --- | --- |
| Chrome | `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选择 `dist/browser/chromium` |
| Edge | `edge://extensions` → 开发人员模式 → 加载解压缩的扩展 → 选择 `dist/browser/chromium` |
| Firefox | `about:debugging#/runtime/this-firefox` → 临时载入附加组件 → 选择 `dist/browser/firefox/manifest.json` |

Firefox 的临时安装会在退出浏览器后失效，需要重新载入；正式持续安装需要 Mozilla 签名。本项目不自动发布到扩展商店。

构建还生成 `dist/pi-browser-capture-chromium.zip` 和 `dist/pi-browser-capture-firefox.zip`，解压后按上表加载。运行 `npm pack` 可以生成包含预构建扩展的 npm 分发包；不支持直接安装尚未构建的 Git 源码。

## 首次配对

1. 启动 Pi，执行 `/browser-capture pair`。
2. 打开浏览器扩展，将 Pi 显示的令牌粘贴到“连接设置”，点击“配对并连接”。
3. 看到“会话在线”后即可使用。同一 Pi 用户配置目录下的所有进程共用令牌，通常只配对一次。

Pi 扩展监听 `127.0.0.1:43821–43852` 中的空闲端口，浏览器主动连接。无需手动启动服务；两端退出、重载或断线后会自动恢复连接。若所选会话切换或消失，必须重新选择，内容不会被自动转发给另一会话。

## 日常使用

1. 在普通 HTTP / HTTPS 网页点击扩展图标，选择“矩形框选”或“元素点选”。也可按 `Alt+Shift+P` 直接框选。
2. 拖动矩形，或悬停高亮后点击元素。按 `Esc` 取消。
3. 在扩展预览窗口查看截图、DOM，填写附加提示词，选择 Pi 会话。
4. 点击“添加到 Pi 草稿”，回到终端继续编辑并提交。

已有输入不会被覆盖。多个选区可以追加到同一草稿。Pi 编辑器上方显示附件数量，草稿内包含 `[pi-browser-capture:…]` 标记；删除某个标记即可取消该图片和完整 DOM 的提交。附带的普通文字仍可自由编辑或删除。

截图预览位于浏览器窗口；Pi 终端中展示摘要，用户提交时通过 Pi `input` 事件合并图片。兼容已有图片及 Pi 原生 `steer` / `followUp` 输入。使用支持图片的模型；文本模型会阻止网页图片提交并提示切换。

### 可选登录状态

“携带当前站点登录状态”默认关闭。开启时浏览器会按需申请 Cookie 和当前站点权限，采集：

- 当前页面 URL 对应的 Cookie，包括可访问的 HttpOnly Cookie，并匹配源标签页的 Cookie store。
- 顶层页面当前 origin 的 localStorage 和 sessionStorage。
- 浏览器支持时的分区 Cookie；无法取得时在摘要中说明。Firefox 的 first-party isolation 模式若要求额外上下文，保留 Storage 并说明 Cookie 不可用，不跨隔离域查询。[Cookie 隔离规则](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/cookies/getAll)

原值只写入 **本机 `login-state.json`**；草稿包含数量摘要和路径，不自动展开 Cookie / Storage 内容。Agent 后续读取该文件时，文件内容仍可能进入模型上下文。没有自动执行已登录请求或恢复登录的工具；某些网站依赖其他存储、设备绑定或服务器状态，不能保证用该文件复现登录。

### 命令与附件文件

| 命令 | 行为 |
| --- | --- |
| `/browser-capture pair` | 显示配对令牌 |
| `/browser-capture status` | 查看监听端口、当前会话和附件目录 |
| `/browser-capture list` | 列出当前会话保存的附件及路径 |
| `/browser-capture delete <UUID>` | 删除当前会话的指定附件，并移除草稿里的对应标记 |

默认目录为 `~/.pi/agent/browser-capture/`；设置 `PI_CODING_AGENT_DIR` 时随之变化。每个会话、每次采集使用独立目录：

```text
browser-capture/
  pairing-token
  attachments/<session-id>/<capture-id>/
    screenshot.png
    dom.html
    dom.txt
    page.json
    capture.json
    login-state.json       # 仅在明确勾选时生成
```

Pi 端附件保留至用户删除，不写入项目仓库。浏览器临时预览最多保留 3 个、合计约 8 MB，30 分钟后由后台清理；投递成功或点击丢弃会删除该预览。浏览器临时预览不保存登录状态原值。配对令牌保存在 Pi 用户目录及浏览器扩展存储内，不进入页面 DOM 或普通日志。

## 支持边界

- 只采集**当前视口**内的选区，不做整页滚动拼接。使用截图实际尺寸换算裁剪坐标，支持高 DPI 和浏览器缩放。
- DOM 包含范围内可访问节点、可见文本、必要祖先及定位信息；移除脚本、事件处理器、隐藏节点、密码值和表单当前输入值。截图本身仍反映页面可见内容。
- 支持开放 Shadow DOM 和同源 iframe 的 DOM 采集。跨域 iframe、封闭 Shadow DOM、canvas 等无法提取内部 DOM 时，保留截图及可用外层信息。DOM 是结构快照，不是完整的 CSS、事件或应用运行状态。
- DOM 上限为 1500 个输出节点、HTML / 可见文本各 60,000 字符，遍历也有上限；截断会标记。登录状态上限约 2 MB，超限可取消登录状态后发送。
- 页面在采集过程中发生导航、滚动、尺寸或 DOM 变化时会要求重新选取。动态动画、视频或遮挡关系无法获得完全原子的快照。
- `chrome://`、`edge://`、`about:`、扩展商店等受限页面不支持。隐私窗口需先在浏览器中允许扩展运行。
- 首次发现和断线恢复可能需要数秒；后台被回收时通过闹钟唤醒后重连。失败保留预览，可用相同采集 ID 重试；已经确认的采集不会重复追加。

## 开发与验证

```sh
npm run typecheck
npm test
npm run build
npm run check
```

`npm run check` 会先构建，再运行包括真实 Pi 包加载在内的测试。单独运行 `npm test` 前应至少构建一次。

测试覆盖坐标裁剪、DOM 过滤与截断、附件存储、登录状态隔离、真实 WebSocket 鉴权与去重、多实例路由，以及 Pi 0.84.2 自动发现、草稿保留、图片合并和重载。浏览器实测范围见 [验证记录](docs/verification.md)。

可启动隔离的测试页面与 Pi 运行时：

```sh
node --import tsx scripts/fixture-server.ts
```

测试页面为 `http://127.0.0.1:4173`，使用 `output/playwright/qa-agent` 独立配置和全为 `1` 的测试配对令牌。该脚本仅用于本地 QA，不属于发布包，也不使用真实账号；`/submit` 只检查图片转换，不调用模型。

源码分为 `src/browser`、`src/pi`、`src/shared`。修改后重新构建、重新加载浏览器扩展，并在 Pi 执行 `/reload`。
