# AICourseNote

> A Windows desktop note assistant for online courses, built with Electron, React, and TypeScript.

AICourseNote 把「上课记录」和「课后整理」放到同一个桌面工作流里：一边记笔记，一边整理图片与草稿，还可以结合系统音频转写和 AI 分析，把零散课堂内容沉淀成更容易复习的学习资料。

## Why This Project

很多课程场景里，信息会分散在音频、讲义截图、临时草稿和课后总结之间。AICourseNote 希望把这些动作收拢到一个本地桌面应用里，减少来回切工具的成本。

它当前聚焦这几件事：

- 用三栏桌面布局管理课程、笔记和编辑区
- 用富文本编辑器承接正式笔记内容
- 用图片插入和 PDF 导出支持归档与复习
- 用系统音频转写和 AI 分析辅助课后整理
- 用系统安全存储管理 API key，避免直接写入数据库

## Features

### Note Workspace

- 课程笔记本的新建、重命名、删除与列表管理
- 笔记按更新时间排序，适合快速回到最近内容
- 三栏主界面支持拖拽调节、折叠展开和恢复默认布局

### Rich Text Editing

- 基于 TipTap 的富文本编辑体验
- 支持高亮、颜色、字号、代码块、表格和图片插入
- 保存前会进行 HTML 白名单净化，降低脏内容落库风险

### Export and Assets

- 当前草稿可直接导出为 PDF，不要求先保存
- 本地图片会在导出流程中内联，避免 PDF 丢图
- 图片资源支持本地落盘管理

### Transcript and AI

- 支持系统音频转写，定位在课堂记录场景
- 支持 AI 分析结果查看、删除和另存为新笔记
- AI 结果与原始笔记内容分离，不会自动覆盖正文

### Local-First and Security

- 数据默认保存在本地，不依赖云端数据库
- API key 通过系统安全存储管理
- 设置页可查看当前数据库路径与图片目录路径

## Tech Stack

- Electron
- React 18
- TypeScript
- electron-vite
- TipTap
- sql.js
- sanitize-html
- keytar

## Project Structure

```text
aicoursenote/
├─ src/          # React renderer
├─ electron/     # Electron main process and preload bridge
├─ scripts/      # Build and acceptance helpers
├─ docs/         # Development notes
├─ build/        # Static build assets such as icons
└─ package.json
```

## Getting Started

### Install

```bash
npm install
```

### Run in Development

```bash
npm run dev
```

### Build and Launch

```bash
npm run build
npm run start
```

### Type Check

```bash
npm run typecheck
```

## Packaging

```bash
npm run dist:win
npm run dist:dir
npm run dist:local
```

默认打包输出目录为 `release/`。

## Current Status

这是一个仍在持续迭代中的桌面应用原型，已经具备一套完整可运行的本地课程笔记流程，包括编辑、导出、转写、AI 分析和本地安装分发能力。

当前仓库保留的是源码、配置和文档，不包含以下内容：

- 你的个人数据库
- 已保存的 API key
- 本地日志和临时文件
- `node_modules/`、`out/`、`release/` 等构建产物

## Notes

- 公开展示用的 GitHub 首页是当前这份 [README.md](d:/Myproject/noteAPP/README.md#L1)
- 工作区内部说明已拆分到本地使用的 `README.workspace.md`，默认不会提交
- 更详细的开发上下文可参考 [docs/development.md](d:/Myproject/noteAPP/docs/development.md#L1)
