# 开发文档

## 项目概览

AICourseNote 是一个基于 Electron、React 和 TypeScript 的桌面课程笔记应用，当前版本号为 `0.2.1`。

当前已经落地的核心能力：

- 课程与笔记本管理
- TipTap 富文本编辑
- 本地图片插入与图片资源持久化
- PDF 导出
- 系统音频转写基础链路
- AI 分析任务与结果保存
- API key 系统安全存储
- Windows 安装包与目录内安装模式

## 技术栈

- Electron 35
- React 18
- TypeScript 5
- Vite / electron-vite
- TipTap
- sql.js
- keytar

## 目录结构

```text
AICourseNote/
├─ build/
│  ├─ icon.ico
│  └─ installer.nsh
├─ docs/
│  └─ development.md
├─ electron/
│  ├─ asr-service.ts
│  ├─ audio-capture-manager.ts
│  ├─ db.ts
│  ├─ html-sanitizer.ts
│  ├─ local-runtime.ts
│  ├─ main.ts
│  ├─ preload.ts
│  └─ secure-store.ts
├─ scripts/
│  └─ local-installer/
├─ src/
│  ├─ App.tsx
│  ├─ env.d.ts
│  ├─ main.tsx
│  ├─ styles.css
│  └─ types.ts
├─ capture.html
├─ electron.vite.config.ts
├─ package.json
├─ tsconfig.json
└─ tsconfig.node.json
```

## 主要模块

### 渲染层

- `src/App.tsx`
  应用主界面，包含课程列表、笔记列表、编辑器、课堂助手、设置面板等主要交互。
- `src/types.ts`
  前后端共享的数据类型定义。
- `src/styles.css`
  当前桌面端界面样式。

### 主进程

- `electron/main.ts`
  主进程入口，负责窗口创建、IPC 注册、导出 PDF、转写调度、AI 分析调度和设置读写。
- `electron/preload.ts`
  预加载桥接层，向渲染层暴露安全 API。
- `electron/db.ts`
  SQLite 数据层，负责 schema、CRUD、迁移、图片资源管理等。
- `electron/html-sanitizer.ts`
  笔记 HTML 白名单净化。
- `electron/secure-store.ts`
  API key 的系统安全存储读写。
- `electron/audio-capture-manager.ts`
  系统音频采集运行态管理。
- `electron/asr-service.ts`
  转写服务封装。
- `electron/local-runtime.ts`
  目录内安装模式的数据目录重定向逻辑。

### 打包与安装

- `build/icon.ico`
  Windows 应用图标。
- `build/installer.nsh`
  NSIS 安装器自定义逻辑。
- `scripts/local-installer/`
  本地目录安装包构建脚本与模板。

## 环境要求

- Node.js 20 或更高版本
- npm
- Windows 10/11

建议先确认版本：

```bash
node -v
npm -v
```

## 初始化开发环境

在项目根目录执行：

```bash
npm install
```

安装完成后建议先做一次类型检查：

```bash
npm run typecheck
```

## 本地开发

启动开发模式：

```bash
npm run dev
```

常用命令：

```bash
npm run build
npm run preview
npm run start
npm run start:direct
npm run typecheck
```

说明：

- `npm run dev` 用于日常开发
- `npm run build` 生成生产构建产物
- `npm run start` 用于直接启动 Electron 应用
- `npm run start:direct` 适合某些终端环境下直接拉起 Electron 可执行文件

## 打包命令

便携版：

```bash
npm run dist:win
```

目录版：

```bash
npm run dist:dir
```

NSIS 安装器：

```bash
npm run dist:setup
```

本地目录安装包：

```bash
npm run dist:local
```

打包输出默认位于 `release/`。

## 当前数据与运行目录

默认情况下，应用运行时会使用 Electron 的标准 `userData` 目录保存数据。

目录内安装模式下：

- 程序目录位于安装目标下的 `AICourseNote/`
- 数据目录位于同级 `data/`
- 本地配置文件位于 `AICourseNote/aicoursenote.local.json`

该模式下会把以下运行数据统一重定向到安装目录旁边：

- 数据库
- 图片目录
- 日志目录
- session 数据
- crash dump

## 数据存储说明

当前主要数据包括：

- `notebooks`
- `notes`
- `transcript_sessions`
- `transcript_segments`
- `ai_analysis_jobs`
- `ai_analysis_results`
- `app_settings`

实现位置在 `electron/db.ts`。

当前敏感信息不写入数据库：

- ASR API key
- LLM API key

这些信息通过 `keytar` 写入系统安全存储。

## 图片与导出

图片处理的当前策略：

- 图片文件落地到本地目录
- 笔记正文内保存 `file://` 引用
- 保存和更新时会清理未引用图片
- PDF 导出时会把本地图片转换为内联内容，避免导出丢图

相关实现：

- `electron/db.ts`
- `electron/html-sanitizer.ts`
- `electron/main.ts`

## 转写与 AI

当前仓库已经具备基础链路：

- 系统音频采集
- 转写运行状态管理
- 转写片段保存
- AI 分析任务创建
- AI 结果展示、删除、另存为笔记

当前预置模型策略：

- ASR: `dashscope-asr / qwen3-asr-flash-realtime`
- LLM: `deepseek / deepseek-chat | deepseek-reasoner`

相关代码主要集中在：

- `electron/audio-capture-manager.ts`
- `electron/asr-service.ts`
- `electron/main.ts`
- `src/App.tsx`

## Windows 打包注意事项

- Windows 图标来自 `build/icon.ico`
- NSIS 安装器名称由 `package.json` 中的 `nsis.artifactName` 控制
- 安装器初始化逻辑在 `build/installer.nsh`
- 目录内安装包由 `scripts/local-installer/build-local-installer.mjs` 生成

如果 `electron-builder` 在 Windows 上卡在符号链接或 `winCodeSign` 解压阶段，通常需要：

- 以管理员身份运行终端
- 或启用 Windows 开发者模式

## 推荐开发流程

建议保持下面的节奏：

1. `npm install`
2. `npm run typecheck`
3. `npm run dev`
4. 修改代码
5. 再次执行 `npm run typecheck`
6. 需要验证安装包时执行 `npm run dist:setup`

## 当前维护重点

当前仓库更适合围绕以下方向继续开发：

- 修复桌面端交互和打包问题
- 提升转写链路稳定性
- 优化 AI 分析流程和错误提示
- 改善编辑器与导出体验
- 补充安装、升级和数据迁移验证

## 提交前建议

提交代码前至少执行：

```bash
npm run typecheck
```

如果改动涉及安装、图标、导出或原生依赖，建议额外执行对应的构建验证：

```bash
npm run build
npm run dist:setup
```
