通用配置与任务数据
------------------
首次访问默认英语，可在右上角切换 CN / EN 与 Light / Dark。
UI_LANG 支持 en / zh-CN；重启生效，浏览器手动选择优先，不改变翻译目标语言。
Windows PowerShell 示例：$env:UI_LANG = "zh-CN"，再运行 .\muyu.exe。

在 API settings（API 配置）填写自己的地址、模型和 API Key，然后上传 SRT / VTT。
优先浏览器直连，不限制直连域名，仍受浏览器 CORS、混合内容与本地网络权限约束。
跨域 / 网络连接失败时回退到服务器转发；本轮运行继续转发，手动继续时重试直连。
HTTP 错误、超时或无效译文沿用重试规则，不触发回退。
直连时 Key 只发给模型，转发时经过本站服务器，服务器不保存。
字幕解析、导出和双语合并全部在浏览器完成。

仅服务器转发使用 API_HOSTS 白名单，默认允许 HTTPS / 443：
  integrate.api.nvidia.com,api.deepseek.com,api.openai.com,openrouter.ai
自定义值替换整个列表，填写逗号分隔的精确域名，可附加端口（api.example.com:8443），
不含协议或路径；子域名单独列出，国际域名使用 Punycode。
OpenAI Base URL：https://api.openai.com/v1
OpenRouter Base URL：https://openrouter.ai/api/v1
API_HOSTS=* 允许转发任意公网 HTTPS 接口，仍保留内网、DNS 与重定向保护。
私有部署转发本地模型时，同时配置 ALLOW_PRIVATE_UPSTREAMS=true 和准确的白名单。

服务端持续速率 IP_RPM / HOST_RPM / GLOBAL_RPM 默认 60 / 300 / 600，
最多允许 10 次突发（不超过 RPM）。并发 IP_CONCURRENCY / HOST_CONCURRENCY /
MAX_CONCURRENT_REQUESTS 默认 2 / 8 / 32。直连不计入这些额度。
服务端限流时在浏览器等待，可暂停，不消耗模型错误重试次数。
TRUSTED_PROXIES 指定实际受控代理 IP / CIDR；默认忽略代理头，IPv6 按 /64 共用额度。
限额在每个实例内存中计算，重启重置。环境变量修改后重启生效。

任务保存在 localStorage，不自动过期，可在界面备份或清空。备份不含 Key。
同一浏览器工作区一次运行一个任务，其余排队，不同使用者相互独立。
暂停在途请求时等当前块保存后停止。刷新或关闭执行页面会中断该页调度，
重新打开后可从保存的块手动继续；在途未保存的块可能再次请求模型。
已有译文可随时修正；存储失败时先备份再清理，页面保留有效编辑草稿。

输出被 Token 上限截断时停止原样重试，可调整输出上限或仅缩小未完成部分的分块后继续。
无效术语会被跳过，无效风格备忘沿用上一轮；有效译文仍保存，运行记录会说明原因。
新增术语的原文必须匹配当前字幕块，误从译文或上下文提取的条目会跳过，不额外请求模型。
总词表没有固定条数上限；每轮最多新增 40 条，发送的相关子集最多 6000 个 Unicode 字符。
完整词表占用浏览器存储，达到实际配额时暂停并提示备份；已有和手动添加的术语不会自动删除。
术语与风格编辑支持自动保存、输入法和跨标签页冲突处理，开始任务前先保存本页草稿。
损坏的日志可降级读取；无法读取的任务单独列为恢复记录，原始数据可下载后修复导入。
旧任务与备份自动迁移到版本 3。更新程序后请刷新已有标签页。

构建信息见 BUILD.json，第三方许可见 THIRD_PARTY_NOTICES.txt。
打包时检查程序架构与全部嵌入资源；本地验证范围见源码包 BUILDINFO.md，
GitHub 自动构建的检查结果见对应 Actions 运行。
