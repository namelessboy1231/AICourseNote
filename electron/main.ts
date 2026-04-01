import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AudioCaptureManager } from './audio-capture-manager';
import { AsrTranscriptionService } from './asr-service';
import { getDatabaseStore } from './db';
import { sanitizeNoteHtml } from './html-sanitizer';
import { applyLocalRuntimePaths, LOCAL_RUNTIME_CONFIG_FILE, writeLocalRuntimeConfig } from './local-runtime';
import { clearAllSecureApiKeys } from './secure-store';

type AiAnalysisType = 'summary' | 'key-points' | 'outline' | 'review-questions' | 'action-items';

const DEEPSEEK_CHAT_COMPLETIONS_URL = 'https://api.deepseek.com/chat/completions';
const MAX_ANALYSIS_SOURCE_LENGTH = 12000;

applyLocalRuntimePaths();

function getCliArgumentValue(name: string) {
  const argument = process.argv.find((item) => item === name || item.startsWith(`${name}=`));

  if (!argument) {
    return '';
  }

  if (argument === name) {
    return 'true';
  }

  return argument.slice(name.length + 1);
}

async function runMaintenanceTask(taskName: string) {
  switch (taskName) {
    case 'clear-secure-store':
      await clearAllSecureApiKeys();
      return 0;
    case 'write-local-runtime-config': {
      const dataDir = getCliArgumentValue('--local-data-dir').trim() || 'data';

      const configPath = path.join(path.dirname(process.execPath), LOCAL_RUNTIME_CONFIG_FILE);
      writeLocalRuntimeConfig(configPath, dataDir);
      return 0;
    }
    default:
      throw new Error(`未知维护任务：${taskName}`);
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeFileName(value: string) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || '未命名笔记';
}

function getMimeTypeByExtension(filePath: string) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.bmp':
      return 'image/bmp';
    default:
      return 'application/octet-stream';
  }
}

async function inlineLocalImagesForPdf(contentHtml: string) {
  const sanitizedHtml = sanitizeNoteHtml(contentHtml);
  const { readFile } = await import('node:fs/promises');

  const imageMatches = Array.from(sanitizedHtml.matchAll(/<img\b([^>]*?)\ssrc="([^"]+)"([^>]*)>/gi));

  if (!imageMatches.length) {
    return sanitizedHtml;
  }

  let nextHtml = sanitizedHtml;

  for (const match of imageMatches) {
    const fullMatch = match[0];
    const beforeSrc = match[1] ?? '';
    const src = match[2] ?? '';
    const afterSrc = match[3] ?? '';

    if (!src.toLowerCase().startsWith('file://')) {
      continue;
    }

    try {
      const imagePath = fileURLToPath(src);
      const imageBuffer = await readFile(imagePath);
      const mimeType = getMimeTypeByExtension(imagePath);
      const dataUrl = `data:${mimeType};base64,${imageBuffer.toString('base64')}`;
      nextHtml = nextHtml.replace(fullMatch, `<img${beforeSrc} src="${dataUrl}"${afterSrc}>`);
    } catch {
      continue;
    }
  }

  return nextHtml;
}

function createPrintableNoteHtml(title: string, contentHtml: string) {
  const sanitizedContentHtml = sanitizeNoteHtml(contentHtml);

  return `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(title)}</title>
    <style>
      @page {
        size: A4;
        margin: 18mm 15mm 18mm;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        color: #172b44;
        font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
        line-height: 1.75;
        font-size: 14px;
      }

      .page {
        width: 100%;
      }

      h1 {
        margin: 0 0 16px;
        color: #10233b;
        font-size: 28px;
        line-height: 1.25;
      }

      h2, h3, h4 {
        color: #16314f;
        margin-top: 20px;
        margin-bottom: 8px;
      }

      p, li {
        word-break: break-word;
      }

      img {
        max-width: 100%;
        height: auto;
      }

      pre, code {
        font-family: "Cascadia Code", "Consolas", monospace;
      }

      pre {
        white-space: pre-wrap;
        padding: 12px;
        border-radius: 12px;
        background: #eef4fb;
      }

      blockquote {
        margin: 12px 0;
        padding-left: 14px;
        border-left: 4px solid #9fc3ef;
        color: #375778;
      }

      table {
        width: 100%;
        border-collapse: collapse;
      }

      th, td {
        border: 1px solid #c6d5e8;
        padding: 8px 10px;
        vertical-align: top;
      }

      th {
        background: #eef4fb;
      }
    </style>
  </head>
  <body>
    <main class="page">
      <h1>${escapeHtml(title)}</h1>
      ${sanitizedContentHtml || '<p></p>'}
    </main>
  </body>
</html>`;
}

async function exportNoteAsPdf(payload: { title: string; contentHtml: string }) {
  const nodeFs = await import('node:fs');
  const suggestedName = `${sanitizeFileName(payload.title.trim() || '未命名笔记')}.pdf`;
  const defaultPath = path.join(app.getPath('documents'), suggestedName);
  const saveResult = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: '导出笔记为 PDF',
    defaultPath,
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation']
  });

  if (saveResult.canceled || !saveResult.filePath) {
    return {
      canceled: true,
      filePath: null
    };
  }

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      javascript: false
    }
  });

  try {
    const printableContentHtml = await inlineLocalImagesForPdf(payload.contentHtml);
    const htmlDataUrl = `data:text/html;charset=UTF-8,${encodeURIComponent(
      createPrintableNoteHtml(payload.title, printableContentHtml)
    )}`;
    await printWindow.loadURL(htmlDataUrl);
    const pdfBuffer = await printWindow.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0
      }
    });

    nodeFs.writeFileSync(saveResult.filePath, pdfBuffer);

    return {
      canceled: false,
      filePath: saveResult.filePath
    };
  } finally {
    printWindow.destroy();
  }
}

function getAiResultTitle(type: AiAnalysisType) {
  switch (type) {
    case 'summary':
      return '课程摘要';
    case 'key-points':
      return '重点提炼';
    case 'outline':
      return '结构化提纲';
    case 'review-questions':
      return '复习题';
    case 'action-items':
      return '行动项';
  }
}

function getAiPromptInstruction(type: AiAnalysisType) {
  switch (type) {
    case 'summary':
      return '请生成一份简洁但完整的课程摘要，分成“主题概览”“核心内容”“结论/提醒”三个小节，使用 Markdown。';
    case 'key-points':
      return '请提炼 5 到 8 条重点，使用 Markdown 无序列表，每条都要具体，不要空话。';
    case 'outline':
      return '请整理成层次清晰的学习提纲，使用 Markdown 有序列表，至少包含 3 个一级项。';
    case 'review-questions':
      return '请基于内容生成 5 道高质量复习题，使用 Markdown 有序列表，不要附答案。';
    case 'action-items':
      return '请给出 5 条可执行的课后行动项，使用 Markdown 无序列表，强调下一步怎么学。';
  }
}

async function runDeepSeekAnalysis(payload: {
  analysisType: AiAnalysisType;
  displayTitle: string;
  sourceText: string;
  model: string;
  apiKey: string;
}) {
  if (!payload.apiKey.trim()) {
    throw new Error('LLM API Key 未配置，请先在设置中填写 DeepSeek API Key。');
  }

  const normalizedSource = payload.sourceText.trim();

  if (normalizedSource.length < 20) {
    throw new Error('可用于 AI 分析的内容太少，请先补充笔记内容或先开始一次转写。');
  }

  const response = await fetch(DEEPSEEK_CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${payload.apiKey.trim()}`
    },
    body: JSON.stringify({
      model: payload.model,
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content:
            '你是 AICourseNote 的课堂学习助手。你只能根据用户提供的课堂笔记或转写内容进行分析，输出必须是简洁、准确、结构清晰的中文 Markdown，不要编造未出现的信息，不要输出代码块围栏。'
        },
        {
          role: 'user',
          content: [
            `分析标题：${payload.displayTitle}`,
            getAiPromptInstruction(payload.analysisType),
            '如果内容里有明显噪声，请自动忽略口头语和重复句。',
            '课堂内容如下：',
            normalizedSource.slice(0, MAX_ANALYSIS_SOURCE_LENGTH)
          ].join('\n\n')
        }
      ]
    }),
    signal: AbortSignal.timeout(60000)
  });

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };

  if (!response.ok) {
    throw new Error(data.error?.message || `AI 分析请求失败（HTTP ${response.status}）。`);
  }

  const content = data.choices?.[0]?.message?.content?.trim();

  if (!content) {
    throw new Error('AI 分析返回了空内容，请重试一次。');
  }

  return {
    title: getAiResultTitle(payload.analysisType),
    contentMarkdown: content
  };
}

let mainWindow: BrowserWindow | null = null;
const audioCaptureManager = new AudioCaptureManager();
const asrTranscriptionService = new AsrTranscriptionService({
  async onSegment(payload) {
    const store = await getDatabaseStore();
    if (payload.segment.isFinal) {
      store.appendTranscriptSegment({
        sessionId: payload.sessionId,
        noteId: payload.noteId,
        text: payload.segment.text,
        normalizedText: payload.segment.normalizedText,
        startMs: payload.segment.startMs,
        endMs: payload.segment.endMs,
        durationMs: payload.segment.durationMs,
        isFinal: payload.segment.isFinal,
        sequenceNo: payload.sequenceNo,
        confidence: payload.segment.confidence,
        rawPayload: payload.segment.rawPayload,
        speakerLabel: payload.segment.speakerLabel
      });
    }

    mainWindow?.webContents.send('transcription:segment', {
      sessionId: payload.sessionId,
      noteId: payload.noteId,
      sequenceNo: payload.sequenceNo,
      text: payload.segment.text,
      isFinal: payload.segment.isFinal
    });
  },
  async onError(payload) {
    const store = await getDatabaseStore();
    store.markTranscriptionSessionError(payload.sessionId);
    audioCaptureManager.reportError(payload.message, payload.sessionId);
    await audioCaptureManager.stop(payload.sessionId);
    mainWindow?.webContents.send('transcription:error', payload);
  }
});

audioCaptureManager.setChunkListener((payload) => {
  void asrTranscriptionService.handleAudioChunk(payload);
});

function getAppIconPath() {
  return path.join(app.getAppPath(), 'build', 'icon.ico');
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1180,
    minHeight: 760,
    title: 'AICourseNote',
    icon: getAppIconPath(),
    backgroundColor: '#f3f6fb',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

const maintenanceTask = getCliArgumentValue('--maintenance-task');

if (maintenanceTask) {
  void runMaintenanceTask(maintenanceTask)
    .then((exitCode) => {
      app.exit(exitCode);
    })
    .catch((error) => {
      console.error(error);
      app.exit(1);
    });
} else {
  app.whenReady().then(() => {
    audioCaptureManager.init();
    getDatabaseStore().then(createMainWindow);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('notes:getSnapshot', async () => {
  const store = await getDatabaseStore();
  return store.getSnapshot();
});

ipcMain.handle(
  'transcription:start',
  async (
    _event,
    payload: {
      notebookId: string;
      noteId?: string | null;
      title?: string;
      language?: string;
      provider?: string;
      model?: string;
    }
  ) => {
    const store = await getDatabaseStore();
    const snapshot = store.startTranscriptionSession(payload);
    const activeSession = snapshot.transcriptSessions.find(
      (session) =>
        session.notebookId === payload.notebookId &&
        session.status === 'recording' &&
        session.title === (payload.title?.trim() || session.title)
    );

    if (activeSession) {
      const settings = await store.getRuntimeAppSettings();

      try {
        await asrTranscriptionService.startSession({
          sessionId: activeSession.id,
          notebookId: activeSession.notebookId,
          noteId: activeSession.noteId,
          language: activeSession.language,
          provider: activeSession.provider ?? settings.asrProvider,
          model: activeSession.model ?? settings.asrModel,
          apiKey: settings.asrApiKey
        });

        await audioCaptureManager.start(activeSession.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : '启动转写失败。';
        store.markTranscriptionSessionError(activeSession.id);
        audioCaptureManager.reportError(message, activeSession.id);
        mainWindow?.webContents.send('transcription:error', {
          sessionId: activeSession.id,
          message
        });
      }
    }

    return store.getSnapshot();
  }
);

ipcMain.handle('transcription:pause', async (_event, payload: { sessionId: string }) => {
  const store = await getDatabaseStore();
  await asrTranscriptionService.pauseSession(payload.sessionId);
  await audioCaptureManager.pause(payload.sessionId);
  return store.pauseTranscriptionSession(payload.sessionId);
});

ipcMain.handle('transcription:resume', async (_event, payload: { sessionId: string }) => {
  const store = await getDatabaseStore();
  await asrTranscriptionService.resumeSession(payload.sessionId);
  await audioCaptureManager.resume(payload.sessionId);
  return store.resumeTranscriptionSession(payload.sessionId);
});

ipcMain.handle('transcription:stop', async (_event, payload: { sessionId: string }) => {
  const store = await getDatabaseStore();
  await asrTranscriptionService.stopSession(payload.sessionId);
  await audioCaptureManager.stop(payload.sessionId);
  return store.stopTranscriptionSession(payload.sessionId);
});

ipcMain.handle('transcription:getRuntimeState', () => {
  return {
    ...audioCaptureManager.getRuntimeState(),
    asrProvider: asrTranscriptionService.getRuntimeState().provider,
    asrModel: asrTranscriptionService.getRuntimeState().model,
    asrConnectionState: asrTranscriptionService.getRuntimeState().connectionState,
    asrSentChunkCount: asrTranscriptionService.getRuntimeState().sentChunkCount,
    asrReceivedMessageCount: asrTranscriptionService.getRuntimeState().receivedMessageCount,
    asrLastEventType: asrTranscriptionService.getRuntimeState().lastEventType,
    asrLastError: asrTranscriptionService.getRuntimeState().lastError,
    asrLastMessagePreview: asrTranscriptionService.getRuntimeState().lastMessagePreview
  };
});

ipcMain.handle(
  'ai:createJob',
  async (
    _event,
    payload: {
      notebookId: string;
      noteId?: string | null;
      sessionId?: string | null;
      analysisType: AiAnalysisType;
    }
  ) => {
    const store = await getDatabaseStore();
    const job = await store.createAiAnalysisJob(payload);

    try {
      if (job.provider !== 'deepseek') {
        throw new Error(`当前仅支持 DeepSeek AI 分析，当前 provider 为 ${job.provider || '未配置'}。`);
      }

      const result = await runDeepSeekAnalysis({
        analysisType: payload.analysisType,
        displayTitle: job.displayTitle,
        sourceText: job.sourceText,
        model: job.model,
        apiKey: job.apiKey
      });

      return store.completeAiAnalysisJob({
        jobId: job.jobId,
        notebookId: payload.notebookId,
        analysisType: payload.analysisType,
        resultBlocks: [result]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'AI 分析失败。';
      return store.failAiAnalysisJob({
        jobId: job.jobId,
        notebookId: payload.notebookId,
        message
      });
    }
  }
);

ipcMain.handle('ai:deleteJob', async (_event, payload: { jobId: string }) => {
  const store = await getDatabaseStore();
  return store.deleteAiAnalysisJob(payload.jobId);
});

ipcMain.handle('ai:saveAsNote', async (_event, payload: { jobId: string; title?: string | null }) => {
  const store = await getDatabaseStore();
  return store.saveAiAnalysisAsNote(payload.jobId, payload.title ?? null);
});

ipcMain.handle(
  'notes:exportPdf',
  async (_event, payload: { title: string; contentHtml: string }) => {
    return exportNoteAsPdf(payload);
  }
);

ipcMain.handle('app:getSettings', async () => {
  const store = await getDatabaseStore();
  return store.getAppSettings();
});

ipcMain.handle(
  'app:saveSettings',
  async (
    _event,
    payload: {
      asrProvider: string;
      asrModel: string;
      llmProvider: string;
      llmModel: string;
      asrApiKeyInput?: string | null;
      llmApiKeyInput?: string | null;
      clearAsrApiKey?: boolean;
      clearLlmApiKey?: boolean;
    }
  ) => {
    const store = await getDatabaseStore();
    return store.saveAppSettings(payload);
  }
);

ipcMain.handle('notes:createNotebook', async (_event, payload: { name: string }) => {
  const store = await getDatabaseStore();
  return store.createNotebook(payload.name);
});

ipcMain.handle(
  'notes:renameNotebook',
  async (_event, payload: { notebookId: string; name: string }) => {
    const store = await getDatabaseStore();
    return store.renameNotebook(payload.notebookId, payload.name);
  }
);

ipcMain.handle('notes:deleteNotebook', async (_event, payload: { notebookId: string }) => {
  const store = await getDatabaseStore();
  return store.deleteNotebook(payload.notebookId);
});

ipcMain.handle('notes:createNote', async (_event, payload: { notebookId: string }) => {
  const store = await getDatabaseStore();
  return store.createNote(payload.notebookId);
});

ipcMain.handle(
  'notes:updateNote',
  async (
    _event,
    payload: { noteId: string; title: string; contentHtml: string }
  ) => {
    const store = await getDatabaseStore();
    return store.updateNote(payload.noteId, payload.title, payload.contentHtml);
  }
);

ipcMain.handle('notes:deleteNote', async (_event, payload: { noteId: string }) => {
  const store = await getDatabaseStore();
  return store.deleteNote(payload.noteId);
});

ipcMain.handle(
  'notes:saveImage',
  async (_event, payload: { dataUrl: string; originalName?: string }) => {
    const store = await getDatabaseStore();
    return store.persistImageDataUrl(payload.dataUrl, payload.originalName);
  }
);
