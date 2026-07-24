# WeChat Kimi Code Bridge

<p align="center">
  <strong>在微信里和 Kimi Code 聊天，就像给朋友发消息一样</strong>
</p>

<p align="center">
  <a href="https://github.com/Ezero23/wechat-kimi-code/blob/main/LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="License: MIT"></a>
  <a href="README_en.md"><img src="https://img.shields.io/badge/Lang-English-lightgrey?style=flat-square" alt="English"></a>
</p>

扫码绑定微信后，你的微信里会多出一个好友。给它发消息，消息会自动转发给你电脑上运行的 Kimi Code，回复也会实时推送到微信。支持文字、图片、语音、文件的收发。

## 核心亮点

| | |
|---|---|
| **扫码即用** | 不用注册账号，不用部署服务器。微信扫码绑定，一分钟搞定。数据全在本地，隐私有保障。 |
| **消息不刷屏** | 只推送核心信息——进度、结果、关键决策。工具调用、中间过程等噪音自动合并，阅读体验清爽。 |
| **"对方正在输入中..."** | Kimi 在处理任务时，微信顶部会显示输入状态，随时感知它在干活。 |
| **电脑手机体验一致** | 手机端和电脑端 Kimi Code 行为完全相同——同样的编排逻辑、同样的输出效果。不是两个割裂的 AI。 |
| **文件双向收发** | 发图片、Word、PDF 给 Kimi 分析；生成的文件也会直接推送到微信，不用回到电脑前查看。 |
| **超时安抚** | 任务处理时间较长时，会自动发送进度消息，不会让你对着空白聊天框干等。 |

## 智能路由

内置零依赖、零训练的本地路由引擎（~5ms 决策），自动为每条消息选择最合适的模型，无需手动切换：

| 模式 | 行为 | 适合场景 |
|------|------|----------|
| **Intelligence** | 始终使用最强模型 | 复杂架构设计、关键代码审查 |
| **Balance**（默认） | 规则 + 语义匹配，按需升级 | 日常开发，质量与成本兼顾 |
| **Cost** | 仅强信号（图片/超长上下文）才触发强模型 | 预算敏感、大量简单问答 |

三个核心机制：

- **Cache-Aware 路由** — 边界信号时保持上一轮的模型不变，最大化 prompt cache 命中率
- **动态升级** — 追踪对话复杂度趋势，连续消息复杂度递增且超过阈值时自动升级到强模型
- **Sticky + 自动降级** — 升级后锁定强模型，连续 3 条闲聊自动降回快速模型，不浪费钱

配置示例（`~/.wechat-kimi-code/routing.json`）：

```json
{
  "mode": "balance",
  "cacheAware": true,
  "sticky": true,
  "models": { "fast": "your-provider/fast", "strong": "your-provider/strong" }
}
```

## 安装

```bash
git clone https://github.com/Ezero23/wechat-kimi-code.git
cd wechat-kimi-code && npm install
```

## 快速开始

### 1. 扫码绑定

```bash
npm run setup
```

弹出二维码，用微信扫码。

### 2. 启动服务

```bash
npm run daemon -- start
```

macOS 下自动注册 launchd，开机自启、崩溃自动重启。

### 3. 开始聊天

打开微信，给你新出现的那个"好友"发条消息试试。

### 管理服务

```bash
npm run daemon -- status   # 查看运行状态
npm run daemon -- stop     # 停止服务
npm run daemon -- restart  # 重启服务（更新代码后使用）
npm run daemon -- logs     # 查看日志
```

## 微信端命令

直接在微信聊天中发送即可：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/clear` | 清除当前会话，开始新对话 |
| `/stop` | 停止当前任务 |
| `/model <名称>` | 切换模型 |
| `/prompt <内容>` | 设置系统提示词（如"用中文回答"） |
| `/cwd <路径>` | 切换工作目录 |
| `/status` | 查看当前会话状态 |
| `/history [数量]` | 查看最近对话记录 |
| `/compact` | 压缩上下文，开始新会话 |
| `/reset` | 完全重置（包括工作目录等设置） |
| `/undo [数量]` | 撤销最近几条对话 |

## 工作原理

```
微信（手机） ←→ iLink Bot API ←→ Node.js 守护进程 ←→ Kimi CLI（本地）
```

守护进程通过长轮询监听微信消息，转发给本地 `kimi` CLI 处理，回复实时流式推送回微信。全程跑在你自己电脑上。

## 前置条件

- Node.js >= 18
- macOS 或 Linux
- 个人微信账号
- 已安装 [Kimi Code](https://www.kimi.com/) CLI 并完成认证

## 数据目录

所有数据存储在 `~/.wechat-kimi-code/`：

```
~/.wechat-kimi-code/
├── accounts/       # 微信账号凭证
├── config.json     # 全局配置
├── routing.json    # 路由配置
├── sessions/       # 会话数据
└── logs/           # 运行日志（每日轮转，保留 30 天）
```

## License

[MIT](LICENSE)
