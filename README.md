# ViewPhone

ViewPhone 是一个本地运行的手机镜像工作台。它通过 USB 数据线连接手机，在浏览器里显示手机画面，并允许用鼠标点击、拖拽和长按手机，适合手工测试和演示。

当前版本是 `0.1.0` 的可用首版，支持：

- Android：ADB 截图，输入点击、长按、滑动、按键和文本
- HarmonyOS NEXT：HDC 截图与 `uitest uiInput` 触控控制
- iOS：WebDriverAgent（WDA）截图与 WDA 触控控制
- Android、iOS、HarmonyOS 全部设备同屏，每块画面可独立操作
- 多设备同步：操作任意一台手机，点击、滑动、长按、按键和文字输入同步到其他在线设备
- 视觉识别同步：开启同步后默认同时比较来源手机与目标手机截图，由视觉模型找到相同按钮、文字或滚动区域，再执行点击或滑动；无法确认同一目标时安全跳过
  - 页面 UI 差异：每次同步动作完成后，等待各设备页面稳定并将全部手机页面拼成一张总览图；右侧集中列出缺失、新增、文字、布局和样式差异，全部差异用编号红框标在同一张图上，点击总览图可缩放查看
- 当前页面识别：设备同屏区“对比已连接设备”、顶部“识别当前页”或右侧差异面板的“识别当前页面差异”按钮均可随时比较当前页面，无需先执行同步操作；会截取全部在线设备页面、相互比较所有设备组合，并在一张总览大图中展示全部页面与差异标记，识别过程只读截图，不会点击或滑动设备
- 同步来源开关：可在网页鼠标操作与实体 Android 手机触控监听之间切换
- 视觉智能测试：输入一段自然语言测试目标，模型逐轮查看当前截图、执行一个动作并重新识别，避免只依赖固定中文句式
- 逐步证据：右侧常驻执行栏实时显示视觉判断，每个动作只保留一张执行结果截图；该结果直接作为下一步的起始画面，并展示相邻步骤的画面差异和新增/消失/移动的页面文字
- 自动执行记录：测试创建时即记录，动作执行中和完成后逐步自动保存；独立的“执行记录”页面支持自然语言检索、按首页、分类、搜索、商品、购物车、结算、订单、支付等流程分类，以及按执行状态筛选；MySQL 可用时写入数据库，连接失败时明确降级到本机文件
- 只读分享：从归档结果生成带过期时间的随机令牌链接，接收方只能查看流程、步骤截图和差异，不能连接或控制手机
- 独立验收：模型申请完成后，再由独立验收请求检查完整执行历史和最终截图，只有 PASS 才标记完成
- 设备总览内置连接状态与工具诊断，同时保留单设备画面锁定和全屏查看
- 默认只监听本机地址，不向外部开放设备控制接口

## 快速开始

要求 Node.js 20 或更高版本。macOS 上首次使用 Android 时，需要安装 Android SDK Platform-Tools 并开启 USB 调试；鸿蒙需要 DevEco Studio 或 HarmonyOS 命令行工具；iOS 需要完整 Xcode 和已签名的 WDA。

```bash
npm install
npm run dev
```

浏览器打开 <http://127.0.0.1:3123>。插上手机、允许这台电脑调试，页面会在几秒内自动识别。进入“设备总览”后，右侧会同时显示各平台的工具、授权和连接状态。

日常稳定运行可使用生产模式：

```bash
npm run build
npm start
```

生产模式同样访问 <http://127.0.0.1:3123>。

## 手机连接准备

### Android

1. 在手机设置中连续点击“版本号”开启开发者选项。
2. 打开“USB 调试”，用数据线连接电脑。
3. 手机弹出“允许 USB 调试吗？”时勾选信任并允许。
4. 如电脑没有 `adb`，从 Android SDK Platform-Tools 安装，并在 `.env.local` 中设置 `ADB_PATH`。

小米、红米等 MIUI/HyperOS 设备若能看到画面但点击报 `INJECT_EVENTS`，还需要在开发者选项中额外开启“USB 调试（安全设置）”并确认。ViewPhone 检测到这一限制时会显示权限提示和“打开设置”按钮；普通 USB 调试并不授予模拟点击权限。

默认 Android 截图不会额外缩放，以免点击坐标失真。USB 较慢时可以把轮询间隔调大：

```dotenv
CLIENT_FRAME_INTERVAL_MS=650
```

### HarmonyOS NEXT

1. 开启开发者选项与 USB 调试。
2. 安装 DevEco Studio，或确保 `hdc` 可执行。
3. 如果 `hdc` 不在 `PATH`，在 `.env.local` 设置 `HDC_PATH`。
4. 手机授权后运行诊断，确认 `hdc list targets` 能看到设备。

ViewPhone 使用 HDC 的 `uitest uiInput` 系统测试接口；部分企业定制系统可能关闭该能力，此时诊断会显示连接成功，但操作会返回明确错误。

如果设备提示 `hdc.exe version is too low`，或诊断显示 HDC 客户端与后台服务版本不一致，请优先使用 DevEco Studio 自带的新版 HDC，并重启 HDC 服务。旧版 HarmonyOS-NEXT-DP2 SDK 中的 HDC 可能无法控制较新的鸿蒙设备。

### iOS

iOS 不能像 Android 一样直接通过 USB 截屏控制，必须使用已签名的 [WebDriverAgent](https://github.com/appium/WebDriverAgent)。这是 Apple 对第三方设备的系统限制，不需要在手机上安装 ViewPhone App，但需要 WDA 在本机运行。

准备工作（一次即可）：

1. 安装完整 Xcode（App Store），运行一次 `sudo xcodebuild -license accept`。
2. 用 Apple ID 登录 Xcode → Settings → Accounts，生成免费个人团队（证书 7 天有效，过期重新构建即可）。
3. 拉取 WDA 源码：`git clone https://github.com/appium/WebDriverAgent.git ~/wda/WebDriverAgent`。
4. 安装端口映射工具：`brew install libimobiledevice`。
5. 在 `.env.local` 里填写（示例见 `.env.example`）：

```dotenv
WDA_URL=http://127.0.0.1:8100
WDA_DEVICE_UDID=00008130-0005641A2632001C   # 只插一台时可不填，自动检测
WDA_DEVELOPMENT_TEAM=XXXXXXXXXX             # Xcode 个人团队 ID
WDA_BUNDLE_ID=com.yourname.viewphone.wda    # 必须全局唯一
VIEWPHONE_WDA_PROJECT=/Users/you/wda/WebDriverAgent
```

启动与保活：

```bash
scripts/start-ios-wda.sh start              # 构建（首次）+ 启动 WDA + iproxy，等到 /status 就绪
scripts/start-ios-wda.sh status             # 健康状态、pid、最近日志
scripts/start-ios-wda.sh restart            # WDA 会话被系统回收后用它重拉
scripts/start-ios-wda.sh stop               # 停止 WDA 与端口映射

# 可选：登录自启 + 崩溃自动重拉（launchd），日志在 .artifacts/wda/launchd.out.log
scripts/start-ios-wda.sh install-launchd
scripts/start-ios-wda.sh uninstall-launchd
```

失败时的排查顺序：手机解锁并保持亮屏 → 手机上「设置 → 通用 → VPN与设备管理」信任开发者证书 → 免费团队证书 7 天过期用 `WDA_FORCE_BUILD=1 scripts/start-ios-wda.sh restart` 重新签名。脚本会把原因打印出来，不会把失败当成成功。

如果已经有 WDA 会话，可选配置 `WDA_SESSION_ID` 复用。ViewPhone 会把截图尺寸与 iOS 逻辑触控尺寸分开处理，避免 Retina 截图造成点击偏移。

## 使用方式

### 视觉智能测试

打开右侧“语义测试流程”，确认选择“视觉智能”，输入测试目标后点击“开始语义测试”。视觉模式不会先强行拆成固定步骤，而是在每一轮执行：

1. 截取手机当前画面；
2. 把完整目标、最近执行历史和截图交给视觉模型；
3. 只执行模型决定的下一步点击、长按、滑动、输入、返回或等待；
4. 重新截图，比较像素与页面文字元素，再进入下一轮；
5. 模型申请完成后，独立验收模型根据目标和过程证据返回 PASS 或 FAIL。

例如可以输入：

```text
点击顶部搜索输入框 → 输入“牛奶” → 点击第一个商品进入详情 → 检查详情页是否出现加购按钮
```

视觉模式识别的是整段测试目标的语义，不要求每个短句都匹配固定命令。条件判断、页面校验和最后的目标验收都由逐步视觉循环完成。右侧执行栏按动作实时出现，不需要切换页面，也不会被截图弹窗遮挡主界面；“点击放大”只打开当前截图的查看层，关闭后继续查看执行过程。

### 测试归档与分享

执行记录会自动完成，无需在测试结束后额外点击归档。测试创建后会立即进入“执行记录”，每一步的执行中、完成状态和截图都会自动保存，即使流程中途失败或服务重启，记录仍然可以查看。点击主工作台或语义测试侧栏顶部的“执行记录”，进入独立页面搜索自然语言目标、步骤判断和页面元素变化，也可以按首页、分类、搜索、商品、购物车、结算、订单、支付等分类，以及待执行、执行中、通过、失败状态筛选。打开一条记录后可查看逐步动作、执行结果截图、识别目标、像素差异和页面文字的新增、消失、移动信息，并生成只读分享链接。

分享链接默认有效 30 天，可在 `.env.local` 使用 `ARCHIVE_SHARE_TTL_DAYS` 调整。链接只返回报告所需字段，截图也只能通过该链接的令牌读取，不会返回设备控制 ID，也不提供重新执行或操作手机的按钮。每次归档保存原始截图文件；只要截图目录还在，服务重启后仍可查看归档。

MySQL 配置沿用 Spring 的变量名，可直接把以下配置放入项目根目录的 `.env.local`：

```dotenv
SPRING_DATASOURCE_URL=jdbc:mysql://localhost:3306/viewPhone?useUnicode=true&characterEncoding=utf8&useSSL=false&serverTimezone=UTC&allowPublicKeyRetrieval=true
SPRING_DATASOURCE_USERNAME=root
SPRING_DATASOURCE_PASSWORD=your-password
ARCHIVE_SHARE_TTL_DAYS=30
```

应用会自动创建 `viewPhone` 数据库和 `test_run_archives` 表。MySQL 未启动或连接失败时，结果仍会写入 `.artifacts/archives/runs`，右侧栏会显示“本机文件归档”及失败原因。`SPRING_DATASOURCE_DRIVER_CLASS_NAME` 可保留用于兼容原配置，但 Node.js 使用 `mysql2`，不会加载 Java JDBC 驱动类。

分享页默认使用生成链接时浏览器访问的地址。若需要在局域网内打开，应使用 `HOST=0.0.0.0` 启动并从该机器的局域网 IP 访问项目；由于主工作台没有身份验证，不能把工作台端口直接暴露到公网。在线分享需要设备所在机器持续运行，或者将该应用部署到团队可访问的内网服务器。

若要运行可选的真机自动化验收，请先关闭模型输出中的高危操作，并使用本地安全页面：

```bash
python3 -m http.server 8765 --directory .artifacts/sync-fixture
```

Android 可通过 `adb reverse tcp:8765 tcp:8765` 打开 `http://127.0.0.1:8765/`。不要在没有明确确认的情况下让视觉模型操作支付、下单、删除或账号安全页面。

“离线步骤”是旧的精确命令模式，只支持“点击…、输入…、向上滑动、等待3秒、等待页面出现…”等固定句式；自由自然语言请使用“视觉智能”。

- 单击画面：在手机对应位置点按
- 全部设备同屏：Android、iOS、HarmonyOS 画面并排展示，不需要点击设备切换
- 多设备同步：在顶部工具栏开启“同步操作”；然后直接操作任意一块在线手机画面，主控与其他在线设备会并行执行相同动作
- 同步来源：“电脑操作”监听网页画面上的点击、拖拽和长按；“手机监听”读取实体 Android 手机的原始触控并同步到其他设备。实体触控监听目前只支持 Android，鸿蒙和 iOS 仍可作为跟随设备
- 手机监听是明确的单一输入来源：直接操作选定 Android 手机，网页画面和快捷控制按钮会自动变为“仅查看”，不会因误点电脑画面而再次操作手机；监听状态会显示“监听中”或具体错误，不会把同一动作回送给来源手机
- 同步位置默认“视觉识别（AI）”：每次网页操作会先保存来源手机的操作前截图，再与目标手机截图一起交给视觉模型，定位相同的按钮、文字、图标或滚动区域。它不依赖固定 UI 控件树，适合 WebView、跨平台 App 和布局不同的设备；模型无法确认同一页面目标时会跳过，不会猜测坐标误点
- 视觉识别需要配置支持图片输入的模型，可用 `ANTHROPIC_*` 或 `OPENAI_*` 兼容变量。每台目标设备单独进行一次视觉判断，因此会产生模型调用，通常比控件匹配慢约数秒；快速连续点击会按顺序执行，避免前一个动作尚未完成就覆盖页面状态
- 每次同步成功后会自动打开右侧“页面差异”面板：系统先等待页面加载和连续截图稳定，再把来源与目标结果页做业务 UI 对比。状态栏时间、电量、信号和两台设备的缩放差异会被忽略；差异类型包括缺失、新增、文字、布局和样式。视觉判断失败时会保留截图并明确显示“未完成”，不会误报为一致
- “页面打点”用于测试人员主动浏览到首页、分类、我的等页面后保存检查点。所有在线设备会并行抓取当前画面，随后异步完成多设备互比和自动归档，执行记录可按页面名称检索；操作后的自动对比仍会等待页面稳定，避免截到加载中的过渡页
- 执行记录和只读分享中的多设备总览使用紧凑缩略图；点击缩略图或“放大查看”可打开完整原图并缩放查看差异标记，三台以上设备也不会挤占整页篇幅
- 页面差异右侧面板默认保留最近 20 组本次浏览器会话中的同步记录，截图和识别结果在服务端暂存 1 小时；它不同于语义测试的历史归档，不写入 MySQL
- 如果不希望调用视觉模型，或页面控件树、OCR 已经能稳定匹配，可以把“定位”改为“控件匹配”：点击、长按按目标手机上的按钮/文字/节点身份定位，滑动按两边对应的滚动区域定位；即使分辨率、状态栏高度或组件间距不同，也不会直接套用来源屏幕坐标
- 控件匹配找不到目标控件时会跳过该设备并在同步状态中显示原因，不会退回比例坐标误点；如页面无法读取节点、确实需要按屏幕位置操作，可手动选择“比例坐标”或“原始像素”
- 鼠标拖拽：在手机上滑动；快速拖拽也会保持足够的触控时长
- 鼠标滚轮：向上或向下滚动手机当前页面
- “向上滚动 / 向下滚动”：在画面下方直接发送稳定的整页滑动
- 按住超过 600 毫秒：长按
- 底部按钮：返回、主页、最近任务、音量键和电源键
- “文字输入”：向当前手机输入文字；Android 请先点击输入框，HarmonyOS 会把文字输入到上次点击位置，iOS 可直接输入
- “可操作 / 已锁定”：锁定后画面仍可查看，但所有操作按钮都会被禁用
- 全屏按钮：用整个屏幕查看手机画面

当前画面是截图轮询模式，因此能看到较真实的 App 内容，但并非原生 60fps 视频。默认约 450ms 一帧，可在 `.env.local` 调整。后续若要低延迟，需要增加 WebSocket 视频通道；Windows/macOS 系统级桌面悬浮窗也可以复用当前设备适配层。

## 配置

复制 `.env.example` 为 `.env.local` 后修改，或在启动进程时设置环境变量。常用配置：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP 监听地址 |
| `PORT` | `3123` | 浏览器工作台端口 |
| `ADB_PATH` | 自动寻找 | ADB 可执行文件 |
| `HDC_PATH` | 自动寻找 | HDC 可执行文件 |
| `WDA_URL` | `http://127.0.0.1:8100` | WebDriverAgent 地址 |
| `WDA_SESSION_ID` | 空 | 复用已存在的 WDA 会话 |
| `CLIENT_FRAME_INTERVAL_MS` | `450` | 浏览器画面轮询间隔 |
| `VISION_MODEL_PROVIDER` | 根据环境推断 | 视觉模型协议，`openai` 或 `anthropic` |
| `VISION_MODEL_API_KEY` | 空 | 视觉模型密钥；只在本地环境设置 |
| `VISION_MODEL_NAME` | 空 | 支持截图输入的模型名称 |
| `VISION_MODEL_API_URL` | 空 | 视觉模型请求地址 |
| `VISION_MODEL_TIMEOUT_MS` | `120000` | 单轮视觉请求超时，单位为毫秒 |
| `VISION_MAX_STEPS` | `30` | 一次视觉测试最多执行的动作数 |
| `VISION_HISTORY_ROUNDS` | `5` | 每轮决策附加的最近动作历史条数 |
| `SPRING_DATASOURCE_URL` | 空 | Spring 风格的 MySQL JDBC 地址；也支持 `MYSQL_URL` |
| `SPRING_DATASOURCE_USERNAME` | 空 | MySQL 用户名；也支持 `MYSQL_USER` |
| `SPRING_DATASOURCE_PASSWORD` | 空 | MySQL 密码；只写入被 Git 忽略的 `.env.local` |
| `ARCHIVE_SHARE_TTL_DAYS` | `30` | 只读分享链接有效天数 |
| `VIEWPHONE_ARCHIVE_ROOT` | `.artifacts/archives` | 可选的本机归档目录 |
| `VIEWPHONE_TEST_RUNS_ROOT` | `.artifacts/test-runs` | 可选的测试截图目录 |

ViewPhone 启动时会自动读取项目根目录的 `.env.local`。该文件已被 Git 忽略，不要提交数据库密码。

不要将 `HOST` 改为 `0.0.0.0` 后直接暴露到公网。接口没有身份验证，允许访问该端口的人即可操作所连接的设备。

## 项目结构

```text
server/
  adapters/           三个平台的画面与操作实现
  discovery/          ADB、HDC、WDA 设备发现
  routes/             浏览器使用的 HTTP API
  services/           设备缓存、动作校验与工具诊断
shared/               前后端共享类型和坐标换算
src/                  React 工作台界面
tests/                Node 原生自动化测试
```

关键接口：

- `GET /api/devices`：列出手机、状态和工具诊断
- `GET /api/devices/:id/frame`：获取当前手机画面
- `POST /api/devices/:id/actions`：发送触控、按键、文本操作
- `POST /api/sync/actions`：把来源操作按控件或滚动容器匹配到另一台手机
- `POST /api/sync/comparisons`：对一次已完成的同步操作自动截取来源与目标稳定页面并生成 UI 差异
- `GET /api/sync/comparisons/:comparisonId/images/:variant`：读取本次页面对比的来源或目标结果截图
- `POST /api/devices/:id/native-touch/start`：启动 Android 实体触控监听
- `GET /api/devices/:id/native-touch?after=<sequence>`：增量读取实体触控手势
- `POST /api/devices/:id/native-touch/stop`：停止 Android 实体触控监听
- `GET /api/archives?q=&category=&status=`：搜索自动执行记录，按流程分类和状态筛选，并返回分类计数与当前实际存储方式
- `GET /api/archives/categories`：获取流程分类及当前筛选条件下的记录数
- `GET /api/archives/:runId`：打开一条归档结果
- `POST /api/archives/:runId/share`：生成或复用只读分享链接
- `GET /api/shares/:token`：读取脱敏后的只读报告
- `GET /api/health`：服务健康检查

## 验证

```bash
npm run check
```

这会执行 TypeScript 检查、动作解析与坐标校验、视觉动作兼容测试和前端生产构建。视觉测试还需要配置支持图片输入的模型；没有配置时，页面会明确提示并保留离线步骤模式。

iOS 必须同时有完整 Xcode、已签名的 WDA 和已授权的数据线连接。WDA 未启动时，设备诊断会明确显示无法连接，不会把 iOS 标记为通过。

多设备同步依赖各手机上的操作入口都可用；MIUI 的模拟点击权限、HarmonyOS 的 `uitest uiInput` 和 iOS 的 WDA 仍需分别配置。同步功能会报告每台接收设备的执行结果，不会把失败静默当成成功。
