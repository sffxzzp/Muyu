# 幕语 · MUYU Subtitle Studio

匿名字幕翻译工作台，使用者填写自己的模型地址与 API Key。Go 提供网页和受保护的模型转发；Vue 前端在构建时通过 `go:embed` 嵌入程序，运行时只需要一个可执行文件。

- SRT / VTT、多语言分块、背景设定、前后文、术语记忆与风格备忘。
- 实时显示每块进度和原文 / 译文对照，支持暂停、续译及已完成行的自动保存编辑。
- 同一浏览器工作区串行执行任务，其余任务排队，跨标签页协调。
- 浏览器直连模型优先，跨域或网络连接失败时回退到服务器转发。
- 任务保存在 localStorage，可备份、导入、手动清空，不自动过期。
- Light / Dark、CN / EN；默认英语，支持部署环境变量覆盖。

## 架构

翻译只有一套实现，始终在浏览器中完成：

1. `subtitle.ts` 解析字幕，`chunking.ts` 根据句界、停顿及大小限制分块。
2. `workspace.ts` 持有任务和编辑草稿；`textEdits.ts` 统一处理自动保存、输入法和冲突；`coordinator.ts` 使用 Web Locks 串行调度并保存 RPM 预约。
3. `runner.ts` 管理当前任务的分块、等待、重试和暂停。
4. `translation.ts` 统一构造提示词、筛选术语、解析模型响应、检查编号与标签、合并完整词表。直连与转发使用相同的请求和解析流程。
5. 每块的译文、术语、风格和断点在一次 localStorage 写入中保存。

Go 的 `internal/relay` 只处理模型传输与出站限制，不再解析字幕或维护翻译规则。`POST /api/relay` 接收已经准备好的 Chat Completions 请求，返回模型响应；仅转发必要的状态和重试信息，不透传上游错误正文、Cookie 或重定向地址。旧的 `/api/translate` 返回 410，提示旧页面刷新；字幕解析、导出、合并均在浏览器本地完成。

页面按创建任务、任务记录、任务详情、双语合并拆分；字幕对照独立为组件。页面切换保留表单、搜索和跟随偏好，编辑草稿由工作区统一持有。主题颜色集中在 `web/src/theme.css`，英文文案在 `web/src/locales/en.json`。运行记录保存消息键与参数，显示时切换语言；旧文本日志在数据迁移时转换。

## 从源码构建

需要 **Go 1.23+**、**Node 22.12+ / npm**。前端先构建到 `web/dist`，Go 再将其嵌入二进制。

```bash
make build
./bin/muyu
```

默认访问 **http://127.0.0.1:7777**。`make` 默认执行 `make build`；首次构建或依赖清单变化时运行 `npm ci`，平时复用已安装依赖。分步命令：

```bash
cd web
npm ci
npm run build
cd ..
CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o bin/muyu ./cmd/muyu
```

也可用 `go generate ./web` 安装并构建前端。直接 `go build` 前必须已有 `web/dist`，嵌入发生在编译阶段。

```bash
make build-windows
# bin/muyu-windows-amd64.exe
make build-windows WINDOWS_ARCH=arm64
```

Make 命令适用于 Linux、macOS、WSL 或具备 GNU Make / shell 的环境。完成前端构建后，可用 `GOOS` / `GOARCH` 直接交叉编译：

```bash
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -o bin/muyu-macos-arm64 ./cmd/muyu
```

本地开发先运行一次 `make build`，再用两个终端分别运行 `go run ./cmd/muyu` 和 `cd web && npm run dev`。Vite 将 `/api` 代理到 `127.0.0.1:7777`；调整后端地址时同步修改 `web/vite.config.ts`。生产环境运行嵌入前端的 Go 程序。

## 部署配置

所有变量在启动时读取，修改后重启即可。公开服务应使用 HTTPS；浏览器的任务锁需要 HTTPS 或 localhost 安全上下文。同机 Caddy 配置见 [`deploy/Caddyfile.example`](deploy/Caddyfile.example)，代理超时建议至少 200 秒。服务不使用 SSE / WebSocket。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LISTEN_HOST` | `127.0.0.1` | 监听 IP / 主机；支持 `0.0.0.0`、`::1` |
| `LISTEN_PORT` | `7777` | 监听端口 |
| `ADDR` | 未设置 | 完整 `host:port`，优先于上述两个变量 |
| `UI_LANG` | `en` | 默认界面语言，支持 `en` / `zh-CN` |
| `API_HOSTS` | `integrate.api.nvidia.com,api.deepseek.com,api.openai.com,openrouter.ai` | 服务器转发的域名白名单，不限制浏览器直连 |
| `IP_RPM` | `60` | 每来源 IP 的 POST API 持续请求速率，每分钟 |
| `HOST_RPM` | `300` | 每个模型域名的服务器转发速率，每分钟 |
| `GLOBAL_RPM` | `600` | 全实例 POST API 持续请求速率，每分钟 |
| `IP_CONCURRENCY` | `2` | 每来源 IP 的并发 POST API 上限 |
| `HOST_CONCURRENCY` | `8` | 每模型域名的并发转发上限 |
| `MAX_CONCURRENT_REQUESTS` | `32` | 全实例的并发 POST API 上限 |
| `TRUSTED_PROXIES` | 未设置 | 可信代理 IP / CIDR，逗号分隔 |
| `ALLOW_PRIVATE_UPSTREAMS` | `false` | 私有部署时允许转发到 HTTP / 内网模型 |

```bash
LISTEN_HOST=0.0.0.0 LISTEN_PORT=9000 UI_LANG=zh-CN ./bin/muyu
```

界面语言优先级为 **浏览器手动选择 → `UI_LANG` → 英语**，不根据浏览器语言自动选择。主题默认跟随系统；手动选择跨标签页同步，并在首次绘制前应用。切换界面语言不改变字幕语言、背景、术语或译文。

### 模型连接与白名单

| 连接方式 | 请求路径 | 限制 |
| --- | --- | --- |
| 浏览器直连（优先） | 浏览器 → 模型 API | 任务 RPM、服务商限额、浏览器 CORS / 混合内容 / 本地网络权限 |
| 服务器转发（回退） | 浏览器 → 幕语 → 模型 API | 上述节奏，加域名白名单、出站保护与服务端额度 |

每次开始或手动继续任务先尝试直连。仅无法取得可读响应的跨域 / 网络连接失败触发回退；本次运行的后续分块继续转发，恢复任务时重新尝试直连。HTTP 401 / 403、429、5xx、超时和无效模型输出按错误或重试规则处理，不触发回退。直连、回退和重试都消耗一次任务 RPM 预约；回退切换不消耗模型错误重试次数。

直连使用 `credentials: omit`、`referrerPolicy: no-referrer`，不携带模型站点 Cookie，不跟随重定向。模型需允许本站来源的 CORS `POST`、`Authorization`、`Content-Type`；如需读取等待时间，应暴露 `Retry-After` 响应头。自设反向代理 CSP 时，需要允许用户 API 地址的 `connect-src`。

直连时 Key 只发给模型地址；回退时 Key 与当前请求经过 Go，服务端不保存或记录。浏览器无法可靠区分 CORS 拒绝和断网；模型可能已经处理了未被页面接收的请求，回退或恢复后可能再次发送当前块。

`API_HOSTS` 未设置或留空时允许：

| 服务 | 域名 | 网页中的 Base URL |
| --- | --- | --- |
| NVIDIA | `integrate.api.nvidia.com` | `https://integrate.api.nvidia.com/v1` |
| DeepSeek | `api.deepseek.com` | `https://api.deepseek.com/v1` |
| OpenAI | `api.openai.com` | `https://api.openai.com/v1` |
| OpenRouter | `openrouter.ai` | `https://openrouter.ai/api/v1` |

自定义值**替换整个默认列表**。填写逗号分隔的精确域名，不含协议、路径、账号或查询参数；省略端口仅允许 443。子域名需分别列出，不支持 `*.example.com`；国际域名使用 Punycode。保留默认服务并增加自定义端口的例子：

```bash
API_HOSTS=integrate.api.nvidia.com,api.deepseek.com,api.openai.com,openrouter.ai,api.example.com:8443 ./bin/muyu
```

转发到未允许域名会返回 403，不向目标发送请求。白名单外接口只要允许浏览器跨域，仍可直连。已有环境变量或 `.env` 的自定义列表会继续覆盖默认值。

`API_HOSTS='*'` 允许任意公网 HTTPS 域名，仍保留内网 / 保留地址检查、实际连接时的 DNS 校验和固定 IP、禁止重定向、忽略环境代理等限制。私有部署转发本地模型时，同时设置 `ALLOW_PRIVATE_UPSTREAMS=true` 和准确的 `API_HOSTS` 地址，例如 `127.0.0.1:11434`。直连本地模型不需要修改这两个服务端变量。

### 服务端限速

来源 IP、模型域名、全实例分别采用持续速率和并发限制，最多允许 10 次突发（不超过 RPM）。直连不占用服务端额度；本地字幕操作也不调用服务器。健康检查、启动配置和网页资源不计入 POST 额度。

达到限制立即返回 429 和 `Retry-After`，服务端不积压任务。浏览器倒计时后继续，这类尚未发往模型的拒绝不消耗模型错误重试次数，即使重试数为 0 也可等待；期间支持暂停。

默认按 TCP 来源 IP 限速并忽略代理头。反向代理部署需把受控代理的实际 IP / CIDR 加入 `TRUSTED_PROXIES`，例如同机 Caddy：

```bash
TRUSTED_PROXIES=127.0.0.1/32,::1/128 ./bin/muyu
```

从右向左检查 `X-Forwarded-For`，在首个不可信跳点停止；Docker / 多层代理应填写后端实际看到的代理地址。共享出口的访问者共用 IP 额度，IPv6 按 `/64` 计算。额度仅存在每个实例内存中，闲置记录会清理，重启重置；多实例统一限速应配置在共同入口。

## Docker Compose

```bash
docker compose up -d --build
```

访问 http://127.0.0.1:7777。需要自定义时复制 `.env.example` 为 `.env`；`MUYU_BIND_IP` / `MUYU_PORT` 控制宿主机映射，容器内监听 `0.0.0.0:7777`。例如 `MUYU_PORT=9000` 改用宿主机 9000 端口，其余应用配置沿用上表。

修改源码后执行 `docker compose up -d --build`。只修改 `.env` 后执行 `docker compose up -d` 重新创建容器，无需重新构建；`docker compose restart` 不加载新的环境变量或网页。查看日志用 `docker compose logs -f muyu`，停止用 `docker compose down`。

Dockerfile 分为 Node 构建前端、Go 嵌入编译、非 root 精简运行镜像三个阶段，包含系统 CA 与第三方许可。任务在访问者浏览器中，无需数据库或数据卷。也支持：

```bash
docker build -t muyu .
docker run --rm -p 127.0.0.1:7777:7777 muyu
```

## GitHub Actions

[`.github/workflows/build.yml`](.github/workflows/build.yml) 在推送分支、PR 和手动运行时测试并构建；推送 `v1.0.0` 等版本标签后，通过全部检查才发布 GitHub Release 和 GHCR 镜像。预发布标签（如 `v1.1.0-rc.1`）不更新 Docker 的稳定版与 `latest` 标签。

| 平台 | 架构 | 发布文件 |
| --- | --- | --- |
| Linux | amd64 / arm64 | `muyu-linux-<arch>.tar.gz` |
| Windows | amd64 / arm64 | `muyu-windows-<arch>.zip` |
| macOS | Intel / Apple Silicon | `muyu-darwin-amd64.tar.gz` / `muyu-darwin-arm64.tar.gz` |

前端只构建一次供六个平台共用。三个系统的原生 runner 执行 Go 测试、vet 和独立目录启动检查；Linux 额外运行 race 和 Playwright。打包检查 PE / ELF / Mach-O 架构和全部嵌入资源，各包包含程序、使用说明、`BUILD.json` 与第三方许可；Windows 直接运行 `muyu.exe`。Release 附带 `SHA256SUMS.txt`。

Docker 同时构建 `linux/amd64`、`linux/arm64`，并执行容器启动检查。镜像名自动采用小写 `ghcr.io/<owner>/<repository>`。发布用 GitHub 提供的 `GITHUB_TOKEN`，无需 Docker Hub 凭据；GHCR 包可见性控制匿名拉取权限。分支构建产物保留 14 天，前端与浏览器报告保留 7 天。

```bash
git tag v1.0.0
git push origin v1.0.0
```

## 翻译与任务行为

每轮仍要求模型返回以下三个字段，没有新增术语时 `glossary` 为 `[]`：

```json
{
  "translations": [{ "id": 42, "text": "这一条的译文。" }],
  "glossary": [{ "source": "cash flow", "target": "现金流", "note": "金融语境" }],
  "style_notes": "使用自然的教学语气。"
}
```

响应按原 ID 归位，严格检查译文完整性、非空文本及内联标签；一个块的译文全部有效才更新进度，没有逐字流式输出。无效的新增术语会被跳过，缺失或无效的术语字段沿用已有词表；风格字段缺失、无效或过长时沿用上一轮备忘。有效译文仍会保存，运行记录说明降级原因。正常每块一轮请求，不增加模型校对或全文预扫描。

### 队列、暂停与恢复

队列属于同一来源下的浏览器工作区，所有标签页合计一次运行一个任务，其余由 Web Locks 按排队顺序接续。不同浏览器、设备、用户配置相互独立，没有服务端 Session。服务端默认 2 个来源 IP 并发是转发请求额度，不是“全站只能两个人使用”。

在途请求完成并保存后暂停；排队、RPM 或重试等待可立即暂停。当前任务完成、暂停或失败后处理下一项。刷新或关闭执行页面会中断该页调度，已保存块保留；重新打开需手动继续，不会静默恢复计费请求。其他仍打开页面中的队列可继续接续。

相同接口与 Key 共享 RPM 预约和 `Retry-After`，切换任务或刷新不会清除已保存的等待时间；不同接口 / Key 独立计时。任务持有开始时的模型与凭据，修改默认 API 配置不影响已运行或排队任务。运行期间可以创建其他任务、修改默认配置和导入备份；活动任务的参数、术语和风格修改需先暂停。

模型明确返回输出被 Token 上限截断时立即停止当前任务，保留已完成进度，不以相同参数反复请求。可以调整输出上限，或在「调整参数」中缩小尚未完成部分的分块后继续。已完成的块、译文、人工修改和术语保持不变；已有译文时源语言与目标语言固定。未收到明确截断标志的无效 JSON、编号或标签错误仍遵循重试设置。

### 对照与人工修正

已完成的译文可随时编辑，停止输入约 0.5 秒或离开编辑框时保存；输入法组合输入结束后再保存。后台断点合并保留人工修改，后续请求在该行处于前文范围内时使用新译文，已发出的请求保持原有上下文。

“跟随翻译进度”只由用户勾选或取消。滚动、翻页会暂缓定位约 1.5 秒，搜索或编辑时也暂缓；之后新进度可继续跟随。“定位当前块”清空搜索并定位一次，不改变勾选状态。翻页栏吸附在屏幕底边。

不同标签页修改同一行发生冲突时，保留本页草稿并显示已保存版本，可选择保存自己的修改或恢复已保存译文。存储失败会暂停翻译，页面保留未保存结果；任务备份包含有效草稿与最新断点。空白或过长草稿不覆盖有效译文。下载字幕前等待修改保存，存在未保存修改时离开页面会触发浏览器提醒。

术语和风格编辑共用同样的自动保存、输入法与冲突保护。词条按固定本地标识更新，跨标签页删除其他词条或调整原文不会让修改落到错误的行上。本地标识不发送给模型。开始或继续任务前先保存本页的术语与风格草稿；已被其他标签页删除的词条不会自动重建，其草稿仍可复制和备份。无法合入任务的草稿会作为恢复记录随备份导出。

### 多语言分块与术语

指定源语言时用 `Intl.Segmenter` 识别句界并映射回完整字幕条目，支持内置名称和受支持的 BCP 47 语言代码。`auto` 由模型识别源语言；分块使用 Unicode 句末规则，也用于未知语言或无 Segmenter 的浏览器。分块结合停顿、缩写保护和大小上限，不拆时间轴；分块字符数按原始 Unicode 码点计，不等同于 Token。迁移时不重算原分块；用户调整分块参数时只重新切分未完成的字幕。

每轮从完整词表匹配当前块与前后文，在序列化 JSON 的 **6000 Unicode 字符预算**内选子集。当前块优先于上下文，同级锁定项优先，再优先完整长短语；无关锁定项不会强制携带。匹配处理大小写、空白、标签、HTML 实体及无空格文字，不额外调用模型。

提示词要求只提取当前块的专名和专业固定表达，避免普通词、代词、月份、泛称及歧义短词。入库前在本地检查新增术语的 `source` 是否匹配当前块原文，沿用上述多语言匹配规则；仅出现在译文、前后文、背景或风格备忘中的词条会跳过并提示，有效字幕照常保存，不因此重试模型请求。提示词要求 `target` 使用本轮译文中的译法；不按字符种类猜测语言，也不一律拒绝原译相同的名称。

新增项与完整词表合并，已有译法和锁定状态保留，冲突记录提示。**总词表没有固定条数上限**，每轮仍最多接收 40 条新增术语，发送子集仍受 6000 Unicode 字符预算约束；完整词表与任务一起占用浏览器 localStorage，达到实际存储配额时暂停并提示备份。预设、手动添加和备份导入的词条不要求出现在当前块中，已有记录不会自动删除。保留最近 20 轮实际携带的词条供查看与备份。风格备忘和用户背景每轮携带。

前文带原文及已完成译文，后文只带原文；两者均可设 0～20，新任务默认各 3 条。旧记录缺少后文设置时补 0。术语记忆是模型的一致性约束，不保证模型始终遵守；修改词表不会自动重译已完成内容。

## 数据与字幕格式

任务记录使用 `muyu.workspace.v1` 键，内部结构版本为 3；沿用原键以完成单次写入迁移。运行状态和 RPM 使用 `muyu.runner.v2`，界面偏好使用 `muyu.ui.v1`。版本 1 / 2 的任务与备份自动迁移，保存的字幕、分块和断点保持不变，并补充稳定的词条标识。升级后请刷新旧版标签页；旧页面无法覆盖新版本记录。运行状态与保存断点分离：重新打开的任务可从最后保存的块恢复。

损坏的日志、术语发送历史或用量统计可降级读取，历史消息键不依赖当前界面词典。字幕、译文或断点无法通过校验的任务会单独出现在「需要恢复的记录」中，原始数据随之后的保存和全部备份保留，其他任务仍可使用。可下载原始记录，修复后重新导入；清理恢复记录需手动确认。整个记录不再是可解析 JSON 时，仍保留原始备份和清空重建入口。

`validation.ts` 统一导入、模型输出、编辑与导出的文本限制，以 UTF-8 字节计算：单条原文 16,000、单条译文 32,000、术语原文 300、术语译法 / 备注各 500、风格备忘 6,000、背景设定 24,000。字幕译文的换行和空白段落按同一规则规范化；这些字节上限与分块的 Unicode 字符预算分别计算。

Key 默认只在当前页内存中，选择记住后才明文保存在 localStorage。任务备份始终排除 Key，包含字幕、参数、模型地址、术语、风格、译文和断点。记录不自动过期；清空按钮只移除本站的键，不调用 `localStorage.clear()`。

localStorage 通常只有数 MB，上传上限 2 MB / 20,000 条；导入成功不代表能存下后续全部译文。站点协议、域名和端口决定存储归属，迁移地址或更换浏览器前用备份转移。恢复粒度是成功保存的块：在途请求可能已被服务商处理但尚未保存，续译可能再次请求该块。

SRT 保留原序号和毫秒时间点。VTT 保留文件头、`NOTE` / `STYLE` / `REGION`、cue 标识与定位设置；时间格式规范化但时间点不变。同格式导出保留元数据，转成 SRT 时省略无法映射的 VTT 元数据。合并要求两份字幕条数和起止时间完全一致，支持混合 SRT / VTT，按原文顺序输出。文件需为 UTF-8。

## 验证与目录

```bash
make test
go vet ./...
cd web
npx playwright install --with-deps chromium
cd ..
make test-e2e
python3 scripts/smoke_test.py --binary bin/muyu --assets web/dist
```

浏览器测试使用本地模型桩，覆盖翻译、直连 / 回退、跨标签页队列、恢复、术语筛选、人工修改、IME、冲突与存储失败、备份、离线文件操作及界面切换，不调用付费模型。Go 测试覆盖转发限制、DNS / 地址检查、白名单、配额和代理头；两条翻译路径使用同一套 TypeScript 协议测试。当前交付的实际验证范围见 [`BUILDINFO.md`](BUILDINFO.md)。

```text
cmd/muyu/                 入口与环境配置
internal/relay/           受保护的 Chat Completions 传输
internal/server/          HTTP、限速、代理 IP、嵌入资源服务
web/embed.go              前端嵌入入口
web/src/pages/            页面
web/src/components/       字幕对照、表单和对话框
web/src/workspace.ts       工作区状态、持久化与编辑草稿
web/src/storage.ts         数据校验、任务隔离恢复与备份
web/src/textEdits.ts       自动保存、输入法与跨标签页草稿冲突
web/src/validation.ts      共享文本限制与规范化
web/src/coordinator.ts     浏览器任务锁与请求额度
web/src/runner.ts          逐块翻译、暂停与重试
web/src/translation.ts     提示词、响应校验与术语合并
web/src/subtitle.ts        本地解析、导出与合并
web/src/migrations.ts      历史数据兼容
web/tests/                本地模型桩与浏览器测试
deploy/                   反向代理和平台启动说明
scripts/                  打包及独立程序启动检查
.github/workflows/        自动测试、跨平台构建与发布
```

实现参考 `subtitle.py` 与 `mergesub.py` 的分块、上下文和双语合并思路。
