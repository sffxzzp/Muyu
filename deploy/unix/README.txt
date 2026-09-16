幕语 MUYU — Linux / macOS 使用说明
===================================

解压后在终端进入本目录，运行 ./muyu，打开 http://127.0.0.1:7777。
网页已嵌入程序，无需安装 Go、Node、Python 或数据库。
保持程序运行，按 Ctrl+C 停止。
macOS 对应 darwin；Intel / AMD 64 位对应 amd64，Apple Silicon / ARM64 对应 arm64。

默认监听 127.0.0.1:7777，自定义示例：
  LISTEN_HOST=0.0.0.0 LISTEN_PORT=9000 ./muyu
也支持优先级更高的 ADDR，例如 ADDR=127.0.0.1:9000 ./muyu。
修改默认界面语言：UI_LANG=zh-CN ./muyu
