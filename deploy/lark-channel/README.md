# 可迁移的飞书机器人配置

config.template.json 源自当前小爱童鞋 profile，保留 App ID、Codex Agent 类型、CardKit 设置、并发、超时、附件及权限配置。

模板不包含 App Secret、OAuth token、加密密钥、会话、媒体、日志、回调 nonce 或锁文件。

在目标机器安装 Node.js、pnpm、Codex CLI 和 lark-cli 后，从仓库根目录运行：

  LARK_APP_SECRET='你的 App Secret' ./deploy/install-bridge.sh

脚本仅在目标机的 ~/.lark-channel/config.json 写入 Secret（权限 0600），构建当前源码并注册/启动 codex profile。已有配置时必须显式传入 --force。

larkCli.identityPreset 保持当前的 user-default。机器人发消息与 CardKit 交互走应用身份；如需用户个人资源，请在新机器按需用 lark-cli auth login 授权。OAuth 登录态不会也不应从仓库迁移。
