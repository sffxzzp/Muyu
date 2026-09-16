幕语 MUYU — Windows 使用说明
=================================

amd64 包适用于 Windows 10 / 11 的 Intel / AMD 64 位电脑。
arm64 包适用于 Windows ARM64 电脑。目标架构及版本见随包的 BUILD.json。

开始使用
--------
1. 将整个 ZIP 解压到任意文件夹，不要直接在压缩包里运行。
2. 双击 muyu.exe。
3. 在浏览器打开 http://127.0.0.1:7777。
4. 在页面的 API settings（API 配置）中填写自己的地址、模型与 API Key，再上传 SRT / VTT。

前端已经嵌入 muyu.exe，不需要安装 Go、Node、Python 或数据库。
使用期间保持程序窗口打开；可按 Ctrl+C 停止服务。
如启动后窗口立即关闭，在程序目录打开 PowerShell，运行 .\muyu.exe 查看错误信息。
任务保存在当前浏览器的 localStorage，不自动过期，可在界面备份或清空。

修改监听地址
------------
默认只允许本机访问，监听 127.0.0.1:7777。
如需调整，在程序目录打开 PowerShell，执行：

  $env:LISTEN_HOST = "0.0.0.0"
  $env:LISTEN_PORT = "9000"
  .\muyu.exe

也支持 ADDR，例如 $env:ADDR = "127.0.0.1:9000"；设置后优先于 LISTEN_HOST / LISTEN_PORT。
如已设置 ADDR，想恢复分别配置，可执行 Remove-Item Env:ADDR -ErrorAction SilentlyContinue。
