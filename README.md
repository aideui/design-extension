# Forge Design

https://github.com/user-attachments/assets/535ce7a8-f746-42ab-ad97-9f0345165487

**让本机的 AI 编程助手用上你自己的 Chrome：点选组件改界面，也能读页面、点按钮、截图、看报错。**

Your local coding agent, in your real Chrome: pick a component to change it, or let the agent read, click, screenshot and debug the page.

Forge Design 是 [Forge UI](https://forgeui.org) 的工具：一个 Chrome 插件加一个本机桥接。AI 由你本机已登录的编程助手来当（Claude Code、Codex 等），它通过桥接操作你正在用的 Chrome，带着你的登录状态。页面内容留在本机，不经过云端。

[Forge UI](https://github.com/forge-ui/forge) · [Forge Starter](https://github.com/forge-ui/forge-starter) · [License: MIT](LICENSE)

## 两种用法

**改界面。** 打开你的应用，在侧边栏点「选择元素」再点页面上的目标，说「把这个按钮改成主色，文案改成保存」。AI 拿到的是真实 selector、文案和样式，直接改你的源码。也可以框选截图画标记，或者从组件盘把 Forge 组件拖到页面上，确认后写进源码。

**让 AI 用你的 Chrome。** 不管在侧边栏还是终端里，都可以让 AI 去看、去点：

- 「打开工场的任务列表，看看今天有几条失败」——带着你的登录状态读页面
- 「把账号页截个整页图」——后台截图，不切走你正在看的标签
- 「这个页面点保存没反应，查一下」——看控制台报错和失败的请求
- 「把这份 Excel 传到导入页」——往文件框或拖拽区上传
- 跨域 iframe、网页组件内部的按钮、严格安全策略的页面，都能读能点

## 为什么用

- **点的就是要改的。** 不靠截图猜 class，也不把整页丢给云端。
- **用的是你的浏览器。** 已登录的后台、内网页面、本机开发环境都能直接用，不用另起一个没登录的无头浏览器。
- **不打扰你。** AI 在自己的后台标签里干活，不抢你正在看的标签。你可以切过去看它干活；在那个标签里点击或打字就算你接管，AI 会换个新标签接着干。
- **几个 AI 同时用也不打架。** 每个调用它的 AI 会话自动有自己的标签，会话结束标签自动关掉，不用任何设置。
- **不绑定某家 AI。** 本机装了哪个、登录了哪个，就用哪个。
- **数据不出本机。** 桥接只监听 `127.0.0.1`。

## 上手

需要 Node.js，以及至少一个已登录的 AI 编程助手（目前支持 [Claude Code](https://claude.com/claude-code)、[Codex](https://github.com/openai/codex)、[Grok CLI](https://grok.x.ai)）。

**1. 启动本机桥接**

```bash
curl -fsSL https://raw.githubusercontent.com/forge-ui/forge-design-extension/main/install.sh | bash
```

装好依赖，拉起 `127.0.0.1:3847`，macOS 上写成开机自启。在仓库里开发时直接 `./install.sh`。

**2. 加载 Chrome 插件**

1. 打开 `chrome://extensions`，打开右上角「开发者模式」
2. 「加载已解压的扩展程序」，选带 `manifest.json` 的 `extension/` 目录
3. 点插件图标打开侧边栏

侧边栏连上桥接之前会显示安装命令，桥接就绪后自动连上。

**3. 让终端里的 AI 也会用（推荐）**

```bash
~/.forge-design/src/install-skill.sh   # 用上面的一行命令装的
./install-skill.sh                     # 在仓库里
```

把使用说明装进本机有的 Claude Code、Codex、Grok，有哪个装哪个。之后在终端里说「看看这个页面」，它就知道该怎么做。侧边栏里的对话不需要这一步。

## 侧边栏

- **选择元素 / 截图标注**：输入框左下角。选中后再说要改什么。
- **组件盘**：点 **+**，把 Forge 组件拖到锚点旁；多个组件按 `#1` `#2` 编号，确认「写入源码」后一次写完。
- **选 AI**：发送键旁的「自动 ▾」只列出本机装好并登录的 AI。「自动」优先用你上次用的那个，还没回复就出错时换下一个；已有的对话固定由原来的 AI 接着答。
- **会话**：标题处拉取会话，默认只看侧边栏里发起的，可切到「全部」；会话旁的按钮能在 Terminal 里接着聊。

## 命令

AI 通过命令行操作页面，你也可以直接用：

```bash
cd server
npm run cli -- goto http://localhost:3000
npm run cli -- snapshot
npm run cli -- click e3
```

| 命令 | 作用 |
|------|------|
| `goto <url>` | 在自己的后台标签打开网址 |
| `snapshot` | 页面文字和可交互元素，每个元素带编号 `e1` `e2`…（iframe 里是 `f3e1`） |
| `text` | 页面纯文字，含各个 iframe |
| `click <选择器或编号>` | 点击 |
| `fill <选择器> <文字>` / `type` / `press Enter` | 填写、输入、按键 |
| `upload <选择器> <文件...>` | 往文件框或拖拽区上传本地文件 |
| `screenshot` | 截图存成文件；`--selector` 截单个元素，`--full` 截整页 |
| `console` / `network` | 页面日志、报错和请求（`--errors` / `--failed`） |
| `eval <js>` | 在页面里执行任意 JavaScript，支持 `await`，不受页面安全策略限制；`--file` 跑脚本文件 |
| `frames` | 列出页面里的 iframe |
| `tabs` / `status` | 所有标签 / 连接状态 |
| `last-pick` / `last-place` | 刚才点选的元素 / 放置的组件 |

任何命令都可以加 `--tab <id>` 指定标签、`--frame <id>` 指定 iframe、`--agent <名字>` 固定用某个后台标签。完整说明在 [`.grok/skills/forge-design/references/commands.md`](.grok/skills/forge-design/references/commands.md)。

截后台标签时 Chrome 会短暂显示「正在调试此浏览器」的提示条，这是截图用到的调试接口，截完就消失。

## HTTP 接口

给其他本机程序用，只绑定本机：

```bash
TOKEN=$(curl -s http://127.0.0.1:3847/token | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')

curl -s -X POST http://127.0.0.1:3847/command \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"command":"snapshot","args":{"agent":"my-script"}}'
```

## 回归测试

桥接和插件连上后，在 `server/` 下：

```bash
npm test      # 单元测试
npm run e2e   # 在你的 Chrome 里用自己的后台标签跑一遍本地测试页，结束关掉它开的标签
```

## 安全

- 桥接只监听 `127.0.0.1`，仅本机可访问；配对用的 token 存在本机。
- AI 用的是你的浏览器和登录状态，能做你在浏览器里能做的事。发帖、付款、删数据这类操作，说明里要求 AI 先问你。
- 页面内容、截图、点选结果都留在本机。

## 相关项目

| 项目 | 说明 |
|------|------|
| [forge-ui/forge](https://github.com/forge-ui/forge) | Forge UI 组件库与文档，站点 [forgeui.org](https://forgeui.org) |
| [forge-ui/forge-starter](https://github.com/forge-ui/forge-starter) | 用 Forge UI 搭管理后台的样板 |
| [forge-ui/forge-agent](https://github.com/forge-ui/forge-agent) | 基于 Forge 的 Agent 产品壳 |

## License

MIT
