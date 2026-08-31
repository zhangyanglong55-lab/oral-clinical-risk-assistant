#!/bin/zsh
cd "$(dirname "$0")" || exit 1
echo "正在启动口腔诊疗风险助手本机AI服务……"
echo "关闭此窗口将停止AI服务。"
node server.js
echo ""
echo "服务已经停止，按回车键关闭窗口。"
read -r
