# 开发文档

## 项目目标

当前版本已完成桌面笔记核心能力与第二阶段存储升级。下一阶段的核心目标是把 AICourseNote 从“桌面笔记本”升级为“桌面网课记录助手”：

- 仅采集系统音频，不接入麦克风
- 将课程音频实时转写为结构化文本片段
- 将转写内容按课程和会话持续保存
- 通过外部 API 调用完成摘要、重点、提纲、复习题等 AI 分析
- 保持 AI 结果与用户正文分离，先以建议和辅助视图形式呈现

## 目录结构

```text
aicoursenote/
├─ electron/
│  ├─ db.ts            # SQLite 数据层、旧数据迁移、图片文件管理
│  ├─ local-runtime.ts # 目录内安装模式下的本地数据目录重定向
│  ├─ main.ts          # Electron 主进程，负责窗口与 IPC 调度
│  └─ preload.ts       # 安全桥接层，向渲染进程暴露 IPC API
├─ src/
│  ├─ App.tsx          # 主界面与交互逻辑
│  ├─ main.tsx         # React 入口
│  ├─ styles.css       # 桌面 UI 样式
│  ├─ types.ts         # 共享数据类型
│  └─ env.d.ts         # window.noteApp 类型声明
├─ docs/
│  └─ development.md   # 当前开发文档
├─ electron.vite.config.ts
├─ package.json
├─ tsconfig.json
└─ tsconfig.node.json
```

## 架构说明

### 1. Electron 主进程

- 创建桌面窗口
- 管理本地数据文件
- 提供 IPC 接口给前端调用
- 后续负责调度本地音频采集 helper、转写 service、AI service

### 2. 预加载层

- 使用 `contextBridge` 暴露有限 API
- 渲染层无法直接访问 Node API，提高安全性
- 后续继续作为转写控制、状态订阅、AI 请求入口

### 3. React 渲染层

- 左侧：课程笔记本列表
- 右上：当前课程的笔记片段列表
- 右下：富文本编辑区
- 左右和上下区域之间提供拖拽分隔条，用户可以自行调整三块区域尺寸
- 第三阶段会新增“实时转写区”和“AI 分析区”，但不会破坏现有三栏桌面布局

## 当前交互增强

- 编辑器支持撤回与重做
- 编辑器支持预设颜色和自定义颜色文字
- 编辑器支持将当前笔记导出为 PDF，导出内容基于当前标题和正文草稿，不要求先保存
- 笔记正文在主进程写入数据库前会经过统一 HTML 白名单净化，PDF 导出也复用同一套净化逻辑
- 图片插入后会自动补一个空段落，避免图片块成为末尾节点后无法继续落光标编辑
- PDF 导出会在主进程内联本地 `file://` 图片，避免打印结果只显示文件名或丢图
- 三块主布局区域尺寸会在本地持久化，重启应用后继续生效
- 编辑器新增字号、高亮、代码块、表格工具
- 笔记片段区和编辑区支持折叠与展开，课程列表保留常驻显示
- 提供恢复默认布局入口，方便用户快速回到初始尺寸
- 列表与卡片视觉层次做了进一步强化，更贴近桌面 IM 的信息密度
- 当前课程区域已加入课堂助手面板，可直接触发真实系统音频采集会话，并调用 DeepSeek 生成 AI 分析结果
- 课程新建、重命名改为应用内表单弹窗，规避系统 prompt 和嵌套点击导致的交互失效
- 笔记片段区和课堂助手已改成分组折叠式功能入口，减少顶部按钮堆积
- 转写片段只在会话期间临时保留；会话停止、异常退出恢复后会自动清理，长期保留的只有已经写入笔记正文的内容
- AI 分析任务会把成功/失败状态写回数据库，失败原因直接在前端结果区展示，便于定位配置或接口错误
- AI 结果与原始笔记严格分离：分析结果可删除，可手动另存为新笔记；另存前会弹出标题编辑框，但不会主动覆盖用户原始笔记内容
- API key 已从 SQLite 明文迁移到系统安全存储；前端只拿到“是否已保存”和掩码预览，并支持替换或清除已有 key
- 新增目录内安装模式：安装包可解压到任意目录，安装后程序本体位于 `AICourseNote/`，本地数据库、图片、日志等固定写入同级 `data/`
- 新增目录内卸载模式：卸载脚本会清理程序目录、数据目录，以及 keytar 中的 AICourseNote API key
- 安装脚本在检测到现有 `data/` 时会显式提示：保留旧数据继续安装，或清空数据执行全新安装

## 当前数据模型

### Notebook

```ts
type Notebook = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};
```

### Note

```ts
type Note = {
  id: string;
  notebookId: string;
  title: string;
  contentHtml: string;
  createdAt: string;
  updatedAt: string;
};
```

## 当前 SQLite 实现

当前数据库由 [electron/db.ts](electron/db.ts) 维护，已落地以下实体：

- `metadata`：记录 schema 版本
- `notebooks`：课程/笔记本
- `notes`：笔记正文
- `transcript_sessions`：转写会话
- `transcript_segments`：转写片段
- `ai_analysis_jobs`：AI 分析任务
- `ai_analysis_results`：AI 分析结果
- `app_settings`：应用设置，只保存 ASR/LLM provider、model 等非敏感信息；API key 改为系统安全存储，前端只暴露预置选项，不再让用户自由输入 provider/model

当前索引：

- `idx_notes_notebook_updated`：用于按课程、更新时间倒序读取笔记
- `idx_transcript_sessions_notebook_updated`
- `idx_transcript_segments_session_seq`
- `idx_transcript_segments_note_created`
- `idx_ai_analysis_jobs_notebook_created`
- `idx_ai_analysis_results_job_sort`

当前图片策略：

- 图片文件落在 `userData/data/images/`
- 笔记 HTML 中只保存 `file://` 路径
- 删除笔记或更新内容时会做未引用图片清理

目录内安装模式下：

- Electron 启动时会优先读取 `AICourseNote/aicoursenote.local.json`
- 若检测到该配置，会把 `userData`、`sessionData`、`logs`、`crashDumps` 统一重定向到同级 `data/`
- 数据库层继续通过 `AICOURSENOTE_DATA_DIR` 读取 `aicoursenote.sqlite` 与 `images/`

## 已实现的 IPC 接口

- `notes:getSnapshot`
- `notes:createNotebook`
- `notes:renameNotebook`
- `notes:deleteNotebook`
- `notes:createNote`
- `notes:updateNote`
- `notes:deleteNote`
- `notes:exportPdf`
- `notes:saveImage`
- `transcription:start`
- `transcription:pause`
- `transcription:resume`
- `transcription:stop`
- `transcription:getRuntimeState`
- `transcription:segment` 事件推送
- `transcription:error` 事件推送
- `ai:createJob`
- `ai:deleteJob`
- `ai:saveAsNote`
- `app:getSettings`
- `app:saveSettings`

## 第二阶段实现策略

### 为什么改为 SQLite

- 数据结构更稳定，便于后续新增表和索引
- 比整文件 JSON 更适合持续扩展
- 为后续实时转写片段、AI 结果缓存、导出功能留出空间

### 为什么图片改为文件落盘

- 减少 HTML 和数据库体积
- 便于后续做图片清理、导出与资源管理
- 更适合长时间积累课堂截图

## 第三阶段当前进度

当前已经落地的部分：

1. SQLite schema 已升级到 `v3`
2. [src/types.ts](src/types.ts) 已扩展转写和 AI 数据类型
3. preload 与主进程已开放转写、运行态和 AI IPC
4. [electron/audio-capture-manager.ts](electron/audio-capture-manager.ts) 已接入 Electron loopback 系统音频采集链路
5. [capture.html](capture.html) + [electron/preload.ts](electron/preload.ts) 构成隐藏采集 helper 页面
6. [src/App.tsx](src/App.tsx) 已加入“课堂助手”面板，可查看采集状态、chunk 数和峰值
7. [electron/asr-service.ts](electron/asr-service.ts) 已加入可插拔 ASR service 骨架，主进程会把音频 chunk 分发到 provider
8. 前端已能订阅 `transcription:segment` / `transcription:error` 事件并自动刷新片段
9. 左上角已加入“设置”入口，当前改为从预置 provider/model 列表中选择，并填写 API key；LLM 侧当前预置 DeepSeek

当前仍未落地的部分：

1. 继续扩充真实流式 ASR provider/model 预置列表
2. API key 从 SQLite 明文存储升级到系统安全存储

## 第三阶段目标拆分

第三阶段建议拆成四个子模块依次开发，避免一次性把音频、云 API、UI、数据改动耦合在一起：

1. 数据层扩展：先补齐转写会话、转写片段、AI 结果表结构与类型
2. UI 骨架：先把“开始转写 / 暂停 / 停止 / 查看片段 / 触发 AI 分析”的界面挂上去
3. 转写链路：接入系统音频采集与流式 ASR API
4. AI 链路：接入摘要、重点、提纲、习题生成，并写入本地库

这样即使第三步尚未完成，前端和数据库也能先联调假数据，开发风险更低。

## 第三阶段总体架构

建议保持“Electron 主进程编排 + 本地 helper 采音 + 云端 API 识别/分析”的结构。

### 1. 为什么不直接在渲染进程抓系统音频

- 浏览器常规 `getDisplayMedia` 能拿到标签页或共享源音频，但不适合桌面端长期稳定抓取系统输出
- 用户要求的是“系统音频 only”，不是麦克风，也不是浏览器标签页特例
- 渲染进程方案对权限、设备切换、音频格式控制都不稳定

### 2. 推荐方案

Windows 侧采用 WASAPI loopback 采集系统输出音频，具体实现建议放在一个独立本地 helper 中，由 Electron 主进程拉起和管理。

推荐形态：

- `audio-helper.exe` 或 Node 原生模块，职责只有系统音频采集与 PCM 输出
- Electron 主进程通过 `child_process` 或本地 WebSocket / stdio 与 helper 通信
- 主进程把音频帧转发给转写 service
- 转写结果与 AI 结果再通过 IPC 推送给前端

### 3. 为什么建议 helper 独立进程

- 把高风险的底层音频采集与 Electron UI 生命周期隔离开
- 便于后续单独替换实现，比如从本地 exe 切到 Rust/Go/C++ helper
- helper 崩溃不会直接拖死主进程窗口
- 更利于定位系统音频权限、采样率、设备兼容性问题

## 模块边界建议

## 当前系统音频实现

由于当前机器没有 .NET SDK，项目没有新增外部 exe helper，而是先落了一版 Electron 内部 helper：

- [electron/audio-capture-manager.ts](electron/audio-capture-manager.ts) 负责创建隐藏采集窗口、管理采集状态和接收 PCM chunk
- [capture.html](capture.html) 是隐藏 helper 页入口
- [electron/preload.ts](electron/preload.ts) 在 helper 页内调用 `getDisplayMedia`，并通过 Electron loopback 抓系统音频
- 主进程通过 `transcription:getRuntimeState` 把 chunk 数、采样率和峰值暴露给前端

这套方案已经满足“系统音频 only”的当前验证需求，也给真实 ASR 接入留好了位置。

## 真实 ASR 接入点

你后面自己接 API 时，优先看这两个位置：

1. [electron/asr-service.ts](electron/asr-service.ts)
  这里已经有 provider 抽象、会话管理、chunk 分发和错误兜底。优先在 `createProvider` 里补你的真实 provider。

2. [electron/db.ts](electron/db.ts)
  这里已经有 [appendTranscriptSegment](electron/db.ts) 对应的方法，可把最终识别结果落到 `transcript_segments`。

3. [electron/main.ts](electron/main.ts)
  主进程已经把 `AudioCaptureManager -> AsrTranscriptionService -> appendTranscriptSegment -> Renderer Event` 这条链路串起来了。

推荐接法：

- 在 `createProvider` 中补真实 provider 实现
- 让 provider 在 `handleChunk` / `stop` 中返回最终片段
- 主进程会自动调用 `appendTranscriptSegment`
- 渲染层会通过事件自动刷新课堂助手面板

当前预置策略：

- 前端通过 [src/App.tsx](src/App.tsx) 内的 provider preset 常量控制可选供应商与模型
- 当前 ASR 仅预置 `dashscope-asr -> qwen3-asr-flash-realtime`
- 当前 LLM 仅预置 `deepseek -> deepseek-chat | deepseek-reasoner`
- 后续新增供应商时，优先扩这些 preset，而不是重新开放自由文本输入

### AudioCaptureManager

位置建议：主进程 service 层

职责：

- 管理 helper 进程生命周期
- 启动/暂停/恢复/停止系统音频采集
- 统一产出固定格式的 PCM 音频块
- 暴露当前设备、采样率、声道、会话状态
- 处理采集异常与重连

输入：

- 当前课程 `notebookId`
- 本次会话配置（语言、采样率、分片时长、是否自动写入笔记）

输出：

- 原始 PCM chunk
- 采集状态事件
- 错误事件

### TranscriptionService

位置建议：主进程 service 层

职责：

- 将 PCM chunk 转成 ASR API 需要的格式
- 管理流式连接、分段提交、心跳、断线重连
- 区分临时识别结果与最终识别结果
- 把最终片段写入 SQLite

输入：

- PCM 音频流
- `transcriptSessionId`
- 识别配置（语言、厂商、模型、时间戳开关）

输出：

- 实时片段事件
- 最终片段事件
- 错误、耗时、费用估算

### AiAnalysisService

位置建议：主进程 service 层

职责：

- 拉取笔记正文和转写片段
- 构造摘要、重点、提纲、复习题 prompt
- 调用外部 LLM API
- 将分析结果写入 SQLite
- 支持重新生成与版本保留

输入：

- `noteId` 或 `transcriptSessionId`
- 分析类型
- prompt 模板与模型配置

输出：

- 结构化 AI 结果
- 调用元信息（模型、token、耗时、状态）

### TranscriptAssembler

位置建议：主进程 service 层或独立 utility

职责：

- 将 ASR 片段按时间顺序拼装
- 识别句子断点和段落边界
- 决定何时自动落到某条笔记中
- 为 AI 分析提供“窗口化上下文”

## 数据库扩展设计

当前 `DATA_VERSION = 3`，以下表已经在 [electron/db.ts](electron/db.ts) 中创建。

### transcript_sessions

记录一次课堂转写会话。

```sql
CREATE TABLE IF NOT EXISTS transcript_sessions (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  note_id TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  language TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  started_at TEXT NOT NULL,
  paused_at TEXT,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);
```

建议约束：

- `source_type` 固定为 `system-audio`
- `status` 取值建议为 `idle | recording | paused | stopped | error`

### transcript_segments

记录识别出来的时间片段。

```sql
CREATE TABLE IF NOT EXISTS transcript_segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  note_id TEXT,
  speaker_label TEXT,
  text TEXT NOT NULL,
  normalized_text TEXT,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  is_final INTEGER NOT NULL DEFAULT 0,
  sequence_no INTEGER NOT NULL,
  confidence REAL,
  raw_payload TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES transcript_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL
);
```

建议索引：

```sql
CREATE INDEX IF NOT EXISTS idx_transcript_segments_session_seq
ON transcript_segments(session_id, sequence_no ASC);

CREATE INDEX IF NOT EXISTS idx_transcript_segments_note_created
ON transcript_segments(note_id, created_at ASC);
```

### ai_analysis_jobs

记录一次 AI 任务调用。

```sql
CREATE TABLE IF NOT EXISTS ai_analysis_jobs (
  id TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  note_id TEXT,
  session_id TEXT,
  analysis_type TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  prompt_version TEXT,
  input_hash TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE,
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE SET NULL,
  FOREIGN KEY (session_id) REFERENCES transcript_sessions(id) ON DELETE SET NULL
);
```

### ai_analysis_results

保存 AI 输出正文，支持一个任务对应多块结果。

```sql
CREATE TABLE IF NOT EXISTS ai_analysis_results (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  result_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL,
  content_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES ai_analysis_jobs(id) ON DELETE CASCADE
);
```

建议 `analysis_type` / `result_type` 枚举先控制在：

- `summary`
- `key-points`
- `outline`
- `review-questions`
- `action-items`

### 可选表：app_settings

如果后续要把 API key、模型配置、自动写入策略、转写语言等做成设置页，建议补一张 KV 表。

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

## 前端数据结构建议

建议在 [src/types.ts](src/types.ts) 中新增以下类型：

```ts
export type TranscriptSessionStatus = 'idle' | 'recording' | 'paused' | 'stopped' | 'error';

export type TranscriptSession = {
  id: string;
  notebookId: string;
  noteId?: string | null;
  title: string;
  status: TranscriptSessionStatus;
  sourceType: 'system-audio';
  language: string;
  provider?: string | null;
  model?: string | null;
  startedAt: string;
  pausedAt?: string | null;
  endedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptSegment = {
  id: string;
  sessionId: string;
  noteId?: string | null;
  text: string;
  normalizedText?: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  isFinal: boolean;
  sequenceNo: number;
  confidence?: number | null;
  createdAt: string;
  updatedAt: string;
};

export type AiAnalysisType =
  | 'summary'
  | 'key-points'
  | 'outline'
  | 'review-questions'
  | 'action-items';

export type AiAnalysisJob = {
  id: string;
  notebookId: string;
  noteId?: string | null;
  sessionId?: string | null;
  analysisType: AiAnalysisType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  provider?: string | null;
  model?: string | null;
  errorMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};
```

## IPC 设计建议

第三阶段不要把所有动作继续塞进 `notes:*` 命名空间，建议拆成 `transcription:*` 与 `ai:*`，这样后续权限与日志也更容易管理。

### transcription

- `transcription:getStatus`
  - 返回当前是否存在活动会话、当前状态、绑定课程和笔记、最近错误
- `transcription:start`
  - 入参：`notebookId`、可选 `noteId`、会话标题、语言、provider、model`
  - 返回：新建 `transcriptSession`
- `transcription:pause`
- `transcription:resume`
- `transcription:stop`
- `transcription:listSessions`
  - 入参：`notebookId`
- `transcription:listSegments`
  - 入参：`sessionId`
- `transcription:bindNote`
  - 用于把转写会话绑定到指定笔记

事件订阅：

- `transcription:statusChanged`
- `transcription:segment`
- `transcription:error`

### ai

- `ai:createJob`
  - 入参：`analysisType`、`notebookId`、可选 `noteId`、可选 `sessionId`
- `ai:listJobs`
- `ai:listResults`
- `ai:rerunJob`
- `ai:deleteJob`

事件订阅：

- `ai:jobUpdated`
- `ai:jobCompleted`
- `ai:jobFailed`

## 转写状态机建议

建议在主进程维护单活动会话状态机，避免同一时间开启多个系统音频采集任务造成混音和写入冲突。

状态流转：

- `idle -> recording`
- `recording -> paused`
- `paused -> recording`
- `recording -> stopped`
- `paused -> stopped`
- 任意活跃态 `-> error`

约束建议：

- 同时只允许一个 `recording` 或 `paused` 会话
- 如果用户切换课程，不自动切换现有转写目标
- 如果当前绑定笔记被删除，转写继续进行，但新片段只入会话，不再自动写正文

## 笔记写入策略建议

AI 与转写不要直接改写用户正在编辑的富文本 DOM，建议通过“结构化导入”落库，再由用户决定是否合并。

推荐策略：

1. 实时转写片段先写 `transcript_segments`
2. 每累计一定字数或时间窗口，再生成“候选追加片段”
3. 用户点击“插入到当前笔记”后，再合并进 `notes.content_html`

如果希望后续支持自动写入，也建议默认写入单独的“课堂实录”分区，例如：

```html
<h2>课堂实录</h2>
<p data-transcript-segment-id="..."></p>
```

这样将来做定位、回放、重算都更容易。

## 外部 API 接入建议

### ASR API

建议优先选择支持流式 WebSocket 或 HTTP chunk 上传的服务。接入时重点看四项：

- 是否支持中文实时识别
- 是否返回最终片段和中间片段
- 是否有时间戳
- 是否能稳定处理 16k / 16bit / mono PCM

建议统一封装成 provider 适配器接口：

```ts
type StreamingAsrProvider = {
  connect(config: StreamingAsrConfig): Promise<void>;
  sendAudioChunk(chunk: Buffer): Promise<void>;
  finalize(): Promise<void>;
  close(): Promise<void>;
};
```

### LLM API

建议统一封装：

```ts
type AiProvider = {
  summarize(input: AnalysisInput): Promise<AiResult[]>;
  extractKeyPoints(input: AnalysisInput): Promise<AiResult[]>;
  buildOutline(input: AnalysisInput): Promise<AiResult[]>;
  generateReviewQuestions(input: AnalysisInput): Promise<AiResult[]>;
};
```

这样后续切换厂商时，不需要动 UI 和数据库。

## 配置与密钥管理建议

由于用户明确要求走 API 模式，建议从一开始就把密钥管理单独设计，不要把 key 写死到前端。

建议原则：

- API key 仅存主进程侧
- 渲染进程只拿到“是否已配置”状态，不拿明文
- 如果需要持久化，优先考虑系统安全存储或最少限度的本地加密
- 所有云调用日志默认不记录完整正文，避免隐私泄漏

## UI 落地建议

第三阶段不建议大改现有主框架，建议在当前 [src/App.tsx](src/App.tsx) 基础上新增两个区域：

### 1. 顶部操作区

新增按钮：

- 开始转写
- 暂停
- 继续
- 停止
- 生成摘要
- 生成重点
- 生成提纲
- 生成复习题

新增状态展示：

- 当前会话名称
- 录制状态
- 已转写时长
- 当前 provider / model

### 2. 右侧辅助抽屉或底部标签页

用于展示：

- 实时转写流
- AI 摘要
- 重点提炼
- 提纲
- 复习题

这样可以避免把现有编辑器主区域挤坏，也更符合桌面端多面板交互。

## 错误处理建议

第三阶段新增失败点明显增多，需要统一错误分层：

### 本地采集错误

- helper 未启动
- 权限不足
- 设备不可用
- 采样率不匹配

### 云端转写错误

- API key 缺失
- 认证失败
- 网络中断
- provider 限流
- 长连接超时

### 云端分析错误

- 输入过长
- provider 返回空结果
- JSON 解析失败
- 任务状态未回写

建议每类错误都落一份结构化日志到主进程日志目录，便于后续排障。

## 开发顺序建议

### Step 1. 先做数据和类型

- 升级 schema 到 v3
- 扩展 [src/types.ts](src/types.ts)
- 扩展 preload API 类型

### Step 2. 再做 UI 骨架

- 增加转写控制栏
- 增加转写面板和 AI 面板
- 用 mock 数据打通页面状态

### Step 3. 接入假 service

- 用定时器模拟转写片段流
- 用本地假响应模拟 AI 输出
- 先验证状态机和数据库写入

### Step 4. 接入真实音频 helper

- 先完成主进程与 helper 通讯
- 再接流式 ASR
- 最后处理暂停/恢复/断线重连

### Step 5. 接入真实 LLM API

- 先做摘要
- 再扩到重点、提纲、复习题
- 最后再考虑“高亮正文”这类二次加工能力

## 验收标准建议

完成第三阶段最小可用版时，至少应满足：

1. 用户能在某个课程下启动一场系统音频转写会话
2. 实时片段可以持续显示，并落到 SQLite
3. 停止后可回看历史转写片段
4. 用户可基于当前笔记或本次转写结果发起 AI 摘要
5. AI 结果会单独保存，重启后仍可查看
6. 任一环节失败时，界面能给出明确状态，而不是静默卡死

## 迁移机制

- 启动时优先读取 SQLite 数据库 `aicoursenote.sqlite`
- 如果数据库为空且发现第一阶段 JSON 文件，则自动迁移旧数据
- 迁移过程中会把 HTML 内的 Data URL 图片写入本地图片目录
- 迁移完成后，旧 JSON 重命名为 `aicoursenote-state.legacy.json`

## 二次开发注意事项

1. 当前项目已经完成 SQLite 化，不要再退回整文件 JSON 持久化。
2. 第三阶段优先把系统音频采集做成独立 helper，不建议把底层采音逻辑直接塞进 React 层。
3. AI 输出默认应作为辅助结果保存，不要未经确认直接覆盖用户正文。
4. 如果未来支持多窗口或同步功能，需要给 IPC 和数据写入增加并发保护。
5. 当前 UI 已经是桌面布局，不建议直接替换成纯 Web 页面样式。

## 验证建议

```bash
npm install
npm run typecheck
npm run build
```

如果需要本地直接验证桌面窗口：

```bash
npm run start
```

若终端环境存在工作目录异常，可改用：

```bash
npm run start:direct
```

## Windows 一键启动交付

为满足“用户双击即可启动”的需求，项目已经接入 `electron-builder`。

### 交付命令

```bash
npm run dist:win
```

输出目录：

- `release/`：包含便携版 exe

如果需要目录版产物：

```bash
npm run dist:dir
```

### 打包注意点

- `sql.js` 的 wasm 文件已配置为 `asarUnpack`
- 主入口仍然指向 `out/main/main.js`
- 最终用户使用打包后的 exe 时，不需要安装 Node.js，也不需要打开终端

如果需要隔离测试数据目录，可在启动前设置环境变量：

```bash
AICOURSENOTE_DATA_DIR=<custom-dir>
```
