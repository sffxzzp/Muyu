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

所有变量在启动时读取，修改后重启即可。公开服务应使用 HTTPS；浏览器的任务锁需要 HTTPS 或 localhost 安全上下文。代理超时建议至少 200 秒。服务不使用 SSE / WebSocket。

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
