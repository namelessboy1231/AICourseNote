import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import initSqlJs, { type Database } from 'sql.js';
import { sanitizeNoteHtml } from './html-sanitizer';
import {
  deleteSecureApiKey,
  getSecureApiKey,
  getSecureApiKeyMeta,
  setSecureApiKey,
  type SecureApiKeyName
} from './secure-store';

type NotebookRow = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

type NoteRow = {
  id: string;
  notebookId: string;
  title: string;
  contentHtml: string;
  createdAt: string;
  updatedAt: string;
};

type LegacyState = {
  version?: number;
  notebooks?: NotebookRow[];
  notes?: NoteRow[];
};

type Snapshot = {
  notebooks: Array<NotebookRow & { noteCount: number }>;
  notes: NoteRow[];
  transcriptSessions: TranscriptSessionRow[];
  transcriptSegments: TranscriptSegmentRow[];
  aiAnalysisJobs: AiAnalysisJobRow[];
  aiAnalysisResults: AiAnalysisResultRow[];
};

type TranscriptSessionStatus = 'idle' | 'recording' | 'paused' | 'stopped' | 'error';

type TranscriptSessionRow = {
  id: string;
  notebookId: string;
  noteId: string | null;
  title: string;
  status: TranscriptSessionStatus;
  sourceType: 'system-audio';
  language: string;
  provider: string | null;
  model: string | null;
  startedAt: string;
  pausedAt: string | null;
  endedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type TranscriptSegmentRow = {
  id: string;
  sessionId: string;
  noteId: string | null;
  speakerLabel: string | null;
  text: string;
  normalizedText: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  isFinal: number | boolean;
  sequenceNo: number;
  confidence: number | null;
  rawPayload: string | null;
  createdAt: string;
  updatedAt: string;
};

type AiAnalysisType = 'summary' | 'key-points' | 'outline' | 'review-questions' | 'action-items';

type AiAnalysisJobRow = {
  id: string;
  notebookId: string;
  noteId: string | null;
  sessionId: string | null;
  analysisType: AiAnalysisType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  inputHash: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type AiAnalysisResultRow = {
  id: string;
  jobId: string;
  resultType: AiAnalysisType;
  title: string;
  contentMarkdown: string;
  contentJson: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type AiAnalysisResultBlock = {
  title: string;
  contentMarkdown: string;
};

type SaveAiAnalysisAsNoteResult = {
  snapshot: Snapshot;
  noteId: string;
};

type StoredAppSettingsRow = {
  asrProvider: string;
  asrModel: string;
  llmProvider: string;
  llmModel: string;
  updatedAt: string | null;
};

type AppSettingsRow = {
  asrProvider: string;
  asrModel: string;
  asrApiKeyConfigured: boolean;
  asrApiKeyPreview: string | null;
  llmProvider: string;
  llmModel: string;
  llmApiKeyConfigured: boolean;
  llmApiKeyPreview: string | null;
  databasePath: string;
  imagesDirectoryPath: string;
  updatedAt: string | null;
};

type RuntimeAppSettingsRow = {
  asrProvider: string;
  asrModel: string;
  asrApiKey: string;
  llmProvider: string;
  llmModel: string;
  llmApiKey: string;
  updatedAt: string | null;
};

type SaveAppSettingsPayload = {
  asrProvider: string;
  asrModel: string;
  llmProvider: string;
  llmModel: string;
  asrApiKeyInput?: string | null;
  llmApiKeyInput?: string | null;
  clearAsrApiKey?: boolean;
  clearLlmApiKey?: boolean;
};

type StorePaths = {
  dataDir: string;
  databasePath: string;
  legacyJsonPath: string;
  legacyBackupPath: string;
  imagesDir: string;
};

const DATA_VERSION = '3';
const DASHSCOPE_REALTIME_DEFAULT_MODEL = 'qwen3-asr-flash-realtime';
const DEEPSEEK_DEFAULT_PROVIDER = 'deepseek';
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat';
const require = createRequire(import.meta.url);

function normalizeAsrProvider(provider: string) {
  return provider.trim().toLowerCase();
}

function normalizeAsrModel(provider: string, model: string) {
  const normalizedProvider = normalizeAsrProvider(provider);
  const normalizedModel = model.trim();

  if (['dashscope-asr', 'dashscope', 'qwen3-asr-flash-realtime'].includes(normalizedProvider)) {
    if (!normalizedModel || normalizedModel === 'paraformer-realtime-v2') {
      return DASHSCOPE_REALTIME_DEFAULT_MODEL;
    }
  }

  return normalizedModel;
}

function normalizeLlmProvider(provider: string) {
  const normalizedProvider = provider.trim().toLowerCase();

  if (!normalizedProvider || normalizedProvider === 'dashscope-llm') {
    return DEEPSEEK_DEFAULT_PROVIDER;
  }

  return normalizedProvider;
}

function normalizeLlmModel(provider: string, model: string) {
  const normalizedProvider = normalizeLlmProvider(provider);
  const normalizedModel = model.trim();

  if (normalizedProvider === DEEPSEEK_DEFAULT_PROVIDER) {
    if (!normalizedModel || normalizedModel === 'qwen-plus') {
      return DEEPSEEK_DEFAULT_MODEL;
    }

    if (['deepseek-chat', 'deepseek-reasoner'].includes(normalizedModel)) {
      return normalizedModel;
    }

    return DEEPSEEK_DEFAULT_MODEL;
  }

  return normalizedModel;
}

function createDefaultAppSettings(): StoredAppSettingsRow {
  return {
    asrProvider: 'dashscope-asr',
    asrModel: DASHSCOPE_REALTIME_DEFAULT_MODEL,
    llmProvider: DEEPSEEK_DEFAULT_PROVIDER,
    llmModel: DEEPSEEK_DEFAULT_MODEL,
    updatedAt: null
  };
}

let storePromise: Promise<DatabaseStore> | null = null;

function getStorePaths(): StorePaths {
  const dataDir = process.env.AICOURSENOTE_DATA_DIR || path.join(app.getPath('userData'), 'data');

  return {
    dataDir,
    databasePath: path.join(dataDir, 'aicoursenote.sqlite'),
    legacyJsonPath: path.join(dataDir, 'aicoursenote-state.json'),
    legacyBackupPath: path.join(dataDir, 'aicoursenote-state.legacy.json'),
    imagesDir: path.join(dataDir, 'images')
  };
}

function ensureStorageDirectories(paths: StorePaths) {
  fs.mkdirSync(paths.dataDir, { recursive: true });
  fs.mkdirSync(paths.imagesDir, { recursive: true });
}

function createDefaultState(): { notebooks: NotebookRow[]; notes: NoteRow[] } {
  const notebookId = randomUUID();
  const noteId = randomUUID();
  const now = new Date().toISOString();

  return {
    notebooks: [
      {
        id: notebookId,
        name: '默认课程',
        createdAt: now,
        updatedAt: now
      }
    ],
    notes: [
      {
        id: noteId,
        notebookId,
        title: '欢迎使用 AICourseNote',
        contentHtml:
          '<h2>欢迎使用 AICourseNote</h2><p>AICourseNote 是一个桌面网课笔记助手，适合一边听课一边整理课程笔记、截图和 AI 分析结果。</p><h3>你现在可以做什么</h3><ul><li>新建和管理课程笔记本</li><li>编辑富文本笔记，插入图片、表格和高亮内容</li><li>把当前笔记导出为 PDF</li><li>配置语音转写和大模型 API Key</li></ul><h3>建议上手顺序</h3><ol><li>先在左侧新建一个课程</li><li>在上方新建一条笔记并输入标题</li><li>在下方正文区域记录课堂内容或插入截图</li><li>需要时打开设置页补充 ASR 和 LLM Key</li></ol><p>如需确认当前程序实际使用的数据库位置，可以在“设置”页面查看。</p>',
        createdAt: now,
        updatedAt: now
      }
    ]
  };
}

function getSqlWasmPath(file: string) {
  const resolvedPath = require.resolve(`sql.js/dist/${file}`);

  if (resolvedPath.includes('app.asar')) {
    return resolvedPath.replace('app.asar', 'app.asar.unpacked');
  }

  return resolvedPath;
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    throw new Error('Unsupported image payload.');
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getAiAnalysisTypeLabel(type: AiAnalysisType) {
  switch (type) {
    case 'summary':
      return '摘要';
    case 'key-points':
      return '重点';
    case 'outline':
      return '提纲';
    case 'review-questions':
      return '复习题';
    case 'action-items':
      return '行动项';
  }
}

function flushMarkdownList(buffer: string[], ordered: boolean) {
  if (buffer.length === 0) {
    return '';
  }

  const tag = ordered ? 'ol' : 'ul';
  const items = buffer.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
  return `<${tag}>${items}</${tag}>`;
}

function renderMarkdownToHtml(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();

  if (!normalized) {
    return '<p></p>';
  }

  const lines = normalized.split('\n');
  const blocks: string[] = [];
  let unorderedItems: string[] = [];
  let orderedItems: string[] = [];

  const flushLists = () => {
    if (unorderedItems.length > 0) {
      blocks.push(flushMarkdownList(unorderedItems, false));
      unorderedItems = [];
    }

    if (orderedItems.length > 0) {
      blocks.push(flushMarkdownList(orderedItems, true));
      orderedItems = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushLists();
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      if (orderedItems.length > 0) {
        blocks.push(flushMarkdownList(orderedItems, true));
        orderedItems = [];
      }

      unorderedItems.push(line.slice(2).trim());
      continue;
    }

    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (unorderedItems.length > 0) {
        blocks.push(flushMarkdownList(unorderedItems, false));
        unorderedItems = [];
      }

      orderedItems.push(orderedMatch[1].trim());
      continue;
    }

    flushLists();

    if (line.startsWith('### ')) {
      blocks.push(`<h4>${escapeHtml(line.slice(4).trim())}</h4>`);
      continue;
    }

    if (line.startsWith('## ')) {
      blocks.push(`<h3>${escapeHtml(line.slice(3).trim())}</h3>`);
      continue;
    }

    if (line.startsWith('# ')) {
      blocks.push(`<h2>${escapeHtml(line.slice(2).trim())}</h2>`);
      continue;
    }

    blocks.push(`<p>${escapeHtml(line)}</p>`);
  }

  flushLists();
  return blocks.join('');
}

function guessExtension(mimeType: string, originalName?: string) {
  const explicitExtension = originalName?.split('.').pop()?.toLowerCase();

  if (explicitExtension && explicitExtension.length <= 5) {
    return explicitExtension;
  }

  const extensionMap: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
  };

  return extensionMap[mimeType] ?? 'png';
}

function extractManagedImagePaths(html: string, imagesDir: string) {
  const matches = Array.from(html.matchAll(/src=(['"])(file:[^'"]+)\1/g));
  const paths = new Set<string>();

  for (const match of matches) {
    try {
      const filePath = fileURLToPath(match[2]);

      if (filePath.startsWith(imagesDir)) {
        paths.add(path.normalize(filePath));
      }
    } catch {
      continue;
    }
  }

  return Array.from(paths);
}

async function replaceDataUrlsWithFiles(
  html: string,
  persistImage: (dataUrl: string, originalName?: string) => string
) {
  const matches = Array.from(html.matchAll(/src=(['"])(data:image\/[^'"]+)\1/g));

  if (matches.length === 0) {
    return html;
  }

  let nextHtml = html;
  const cache = new Map<string, string>();

  for (const match of matches) {
    const dataUrl = match[2];
    const fileUrl = cache.get(dataUrl) ?? persistImage(dataUrl);

    cache.set(dataUrl, fileUrl);
    nextHtml = nextHtml.split(dataUrl).join(fileUrl);
  }

  return nextHtml;
}

class DatabaseStore {
  private constructor(
    private readonly db: Database,
    private readonly paths: StorePaths
  ) {}

  static async create() {
    const paths = getStorePaths();
    ensureStorageDirectories(paths);

    const SQL = await initSqlJs({
      locateFile: getSqlWasmPath
    });

    const db = fs.existsSync(paths.databasePath)
      ? new SQL.Database(fs.readFileSync(paths.databasePath))
      : new SQL.Database();

    const store = new DatabaseStore(db, paths);
    store.setupSchema();
    await store.migrateLegacyJsonIfNeeded();
    await store.migrateLegacyApiKeysToSecureStore();
    store.ensureSeedData();
    store.ensureDefaultSettings();
    store.recoverDanglingTranscriptionSessions();
    store.cleanupArchivedTranscriptSegments();
    store.persist();

    return store;
  }

  private setupSchema() {
    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        notebook_id TEXT NOT NULL,
        title TEXT NOT NULL,
        content_html TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (notebook_id) REFERENCES notebooks(id) ON DELETE CASCADE
      )
    `);
    this.db.run(`
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
      )
    `);
    this.db.run(`
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
      )
    `);
    this.db.run(`
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
      )
    `);
    this.db.run(`
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
      )
    `);
    this.db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_notes_notebook_updated ON notes(notebook_id, updated_at DESC)'
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_transcript_sessions_notebook_updated ON transcript_sessions(notebook_id, updated_at DESC)'
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_transcript_segments_session_seq ON transcript_segments(session_id, sequence_no ASC)'
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_transcript_segments_note_created ON transcript_segments(note_id, created_at ASC)'
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_ai_analysis_jobs_notebook_created ON ai_analysis_jobs(notebook_id, created_at DESC)'
    );
    this.db.run(
      'CREATE INDEX IF NOT EXISTS idx_ai_analysis_results_job_sort ON ai_analysis_results(job_id, sort_order ASC)'
    );
    this.db.run(
      `INSERT OR REPLACE INTO metadata (key, value) VALUES ('schemaVersion', '${DATA_VERSION}')`
    );
  }

  private ensureSeedData() {
    const notebookCount = this.getScalarNumber('SELECT COUNT(*) AS count FROM notebooks');

    if (notebookCount > 0) {
      return;
    }

    const state = createDefaultState();

    for (const notebook of state.notebooks) {
      this.insertNotebook(notebook);
    }

    for (const note of state.notes) {
      this.insertNote(note);
    }
  }

  private ensureDefaultSettings() {
    const defaults = createDefaultAppSettings();
    const timestamp = new Date().toISOString();

    Object.entries(defaults).forEach(([key, value]) => {
      this.db.run(
        'INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
        [key, String(value ?? ''), timestamp]
      );
    });
  }

  private async migrateLegacyApiKeysToSecureStore() {
    const legacyRows = this.getRows<{ key: string; value: string }>(
      'SELECT key, value FROM app_settings WHERE key IN (?, ?)',
      ['asrApiKey', 'llmApiKey']
    );

    if (legacyRows.length === 0) {
      return;
    }

    for (const row of legacyRows) {
      const value = row.value.trim();

      if (!value) {
        continue;
      }

      await setSecureApiKey(row.key as SecureApiKeyName, value);
    }

    this.db.run('DELETE FROM app_settings WHERE key IN (?, ?)', ['asrApiKey', 'llmApiKey']);
  }

  private async migrateLegacyJsonIfNeeded() {
    const hasExistingDbData = this.getScalarNumber('SELECT COUNT(*) AS count FROM notebooks') > 0;

    if (hasExistingDbData || !fs.existsSync(this.paths.legacyJsonPath)) {
      return;
    }

    const legacyRaw = fs.readFileSync(this.paths.legacyJsonPath, 'utf-8');
    const legacy = JSON.parse(legacyRaw) as LegacyState;
    const notebooks = legacy.notebooks ?? [];
    const notes = legacy.notes ?? [];

    for (const notebook of notebooks) {
      this.insertNotebook(notebook);
    }

    for (const note of notes) {
      const normalizedHtml = await replaceDataUrlsWithFiles(note.contentHtml, (dataUrl) =>
        this.persistImageDataUrl(dataUrl, `${note.id}.png`)
      );

      this.insertNote({
        ...note,
        contentHtml: normalizedHtml
      });
    }

    fs.renameSync(this.paths.legacyJsonPath, this.paths.legacyBackupPath);
  }

  private persist() {
    fs.writeFileSync(this.paths.databasePath, Buffer.from(this.db.export()));
  }

  private getRows<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
    const statement = this.db.prepare(query, params);
    const rows: T[] = [];

    while (statement.step()) {
      rows.push(statement.getAsObject() as T);
    }

    statement.free();
    return rows;
  }

  private getScalarNumber(query: string, params: unknown[] = []) {
    const row = this.getRows<{ count: number }>(query, params)[0];
    return Number(row?.count ?? 0);
  }

  private insertNotebook(notebook: NotebookRow) {
    this.db.run(
      `INSERT INTO notebooks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [notebook.id, notebook.name, notebook.createdAt, notebook.updatedAt]
    );
  }

  private insertNote(note: NoteRow) {
    const sanitizedHtml = sanitizeNoteHtml(note.contentHtml);

    this.db.run(
      `INSERT INTO notes (id, notebook_id, title, content_html, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [note.id, note.notebookId, note.title, sanitizedHtml, note.createdAt, note.updatedAt]
    );
  }

  private getAllNoteHtml(excludingNoteId?: string) {
    const rows = excludingNoteId
      ? this.getRows<{ contentHtml: string }>('SELECT content_html AS contentHtml FROM notes WHERE id != ?', [excludingNoteId])
      : this.getRows<{ contentHtml: string }>('SELECT content_html AS contentHtml FROM notes');

    return rows.map((row) => row.contentHtml);
  }

  private cleanupUnusedImages(candidates: string[], excludingNoteId?: string) {
    if (candidates.length === 0) {
      return;
    }

    const remainingHtml = this.getAllNoteHtml(excludingNoteId).join('\n');

    for (const candidate of candidates) {
      const fileUrl = pathToFileURL(candidate).toString();

      if (remainingHtml.includes(fileUrl)) {
        continue;
      }

      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
      }
    }
  }

  private touchNotebook(notebookId: string, updatedAt: string) {
    this.db.run('UPDATE notebooks SET updated_at = ? WHERE id = ?', [updatedAt, notebookId]);
  }

  private getNoteById(noteId: string) {
    return (
      this.getRows<NoteRow>(
        `SELECT id, notebook_id AS notebookId, title, content_html AS contentHtml,
                created_at AS createdAt, updated_at AS updatedAt
         FROM notes WHERE id = ?`,
        [noteId]
      )[0] ?? null
    );
  }

  private appendTranscriptToNote(noteId: string, text: string, timestamp: string) {
    const existingNote = this.getNoteById(noteId);

    if (!existingNote || !text.trim()) {
      return;
    }

    const nextHtml = `${existingNote.contentHtml || '<p></p>'}<p>${escapeHtml(text.trim())}</p>`;
    this.db.run('UPDATE notes SET content_html = ?, updated_at = ? WHERE id = ?', [nextHtml, timestamp, noteId]);
    this.touchNotebook(existingNote.notebookId, timestamp);
  }

  private getTranscriptSessionById(sessionId: string) {
    return (
      this.getRows<TranscriptSessionRow>(
        `SELECT id,
                notebook_id AS notebookId,
                note_id AS noteId,
                title,
                status,
                source_type AS sourceType,
                language,
                provider,
                model,
                started_at AS startedAt,
                paused_at AS pausedAt,
                ended_at AS endedAt,
                created_at AS createdAt,
                updated_at AS updatedAt
         FROM transcript_sessions
         WHERE id = ?`,
        [sessionId]
      )[0] ?? null
    );
  }

  private getAiAnalysisJobById(jobId: string) {
    return (
      this.getRows<AiAnalysisJobRow>(
        `SELECT id,
                notebook_id AS notebookId,
                note_id AS noteId,
                session_id AS sessionId,
                analysis_type AS analysisType,
                status,
                provider,
                model,
                prompt_version AS promptVersion,
                input_hash AS inputHash,
                error_message AS errorMessage,
                started_at AS startedAt,
                finished_at AS finishedAt,
                created_at AS createdAt,
                updated_at AS updatedAt
         FROM ai_analysis_jobs
         WHERE id = ?`,
        [jobId]
      )[0] ?? null
    );
  }

  private getAiAnalysisResultsByJobId(jobId: string) {
    return this.getRows<AiAnalysisResultRow>(
      `SELECT id,
              job_id AS jobId,
              result_type AS resultType,
              title,
              content_markdown AS contentMarkdown,
              content_json AS contentJson,
              sort_order AS sortOrder,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM ai_analysis_results
       WHERE job_id = ?
       ORDER BY sort_order ASC, created_at ASC`,
      [jobId]
    );
  }

  private closeActiveTranscriptionSessions(nextStatus: 'stopped' | 'error', timestamp: string) {
    this.db.run(
      `UPDATE transcript_sessions
       SET status = ?, ended_at = COALESCE(ended_at, ?), updated_at = ?
       WHERE status IN ('recording', 'paused')`,
      [nextStatus, timestamp, timestamp]
    );
  }

  private recoverDanglingTranscriptionSessions() {
    const danglingCount = this.getScalarNumber(
      `SELECT COUNT(*) AS count
       FROM transcript_sessions
       WHERE status IN ('recording', 'paused')`
    );

    if (danglingCount === 0) {
      return;
    }

    this.closeActiveTranscriptionSessions('stopped', new Date().toISOString());
  }

  private insertTranscriptSegment(segment: TranscriptSegmentRow) {
    this.db.run(
      `INSERT INTO transcript_segments (
        id, session_id, note_id, speaker_label, text, normalized_text,
        start_ms, end_ms, duration_ms, is_final, sequence_no, confidence,
        raw_payload, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        segment.id,
        segment.sessionId,
        segment.noteId,
        segment.speakerLabel,
        segment.text,
        segment.normalizedText,
        segment.startMs,
        segment.endMs,
        segment.durationMs,
        segment.isFinal,
        segment.sequenceNo,
        segment.confidence,
        segment.rawPayload,
        segment.createdAt,
        segment.updatedAt
      ]
    );
  }

  private insertAiAnalysisJob(job: AiAnalysisJobRow) {
    this.db.run(
      `INSERT INTO ai_analysis_jobs (
        id, notebook_id, note_id, session_id, analysis_type, status, provider, model,
        prompt_version, input_hash, error_message, started_at, finished_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.notebookId,
        job.noteId,
        job.sessionId,
        job.analysisType,
        job.status,
        job.provider,
        job.model,
        job.promptVersion,
        job.inputHash,
        job.errorMessage,
        job.startedAt,
        job.finishedAt,
        job.createdAt,
        job.updatedAt
      ]
    );
  }

  private insertAiAnalysisResult(result: AiAnalysisResultRow) {
    this.db.run(
      `INSERT INTO ai_analysis_results (
        id, job_id, result_type, title, content_markdown, content_json, sort_order, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        result.id,
        result.jobId,
        result.resultType,
        result.title,
        result.contentMarkdown,
        result.contentJson,
        result.sortOrder,
        result.createdAt,
        result.updatedAt
      ]
    );
  }

  private getTranscriptText(sessionId: string) {
    const rows = this.getRows<{ text: string }>(
      'SELECT text FROM transcript_segments WHERE session_id = ? ORDER BY sequence_no ASC',
      [sessionId]
    );

    return rows.map((row) => row.text.trim()).filter(Boolean).join(' ');
  }

  private deleteTranscriptSegmentsBySession(sessionId: string) {
    this.db.run('DELETE FROM transcript_segments WHERE session_id = ?', [sessionId]);
  }

  private cleanupArchivedTranscriptSegments() {
    const archivedCount = this.getScalarNumber(
      `SELECT COUNT(*) AS count
       FROM transcript_segments
       WHERE session_id IN (
         SELECT id FROM transcript_sessions WHERE status IN ('stopped', 'error')
       )`
    );

    if (archivedCount === 0) {
      return;
    }

    this.db.run(
      `DELETE FROM transcript_segments
       WHERE session_id IN (
         SELECT id FROM transcript_sessions WHERE status IN ('stopped', 'error')
       )`
    );
    this.db.run('VACUUM');
  }

  private getAnalysisSourceText(noteId: string | null, sessionId: string | null) {
    const noteText = noteId ? this.getNoteById(noteId)?.contentHtml.replace(/<[^>]*>/g, ' ').trim() ?? '' : '';
    const transcriptText = sessionId ? this.getTranscriptText(sessionId) : '';
    return [noteText, transcriptText].filter(Boolean).join(' ');
  }

  private getAnalysisDisplayTitle(noteId: string | null, sessionId: string | null) {
    const noteTitle = noteId ? this.getNoteById(noteId)?.title : null;
    const sessionTitle = sessionId ? this.getTranscriptSessionById(sessionId)?.title : null;
    return noteTitle || sessionTitle || '课堂笔记分析';
  }

  private getStoredAppSettings(): StoredAppSettingsRow {
    const defaults = createDefaultAppSettings();
    const rows = this.getRows<{ key: string; value: string; updatedAt: string }>(
      'SELECT key, value, updated_at AS updatedAt FROM app_settings'
    );
    const settings: StoredAppSettingsRow = { ...defaults };
    let latestUpdatedAt: string | null = null;

    for (const row of rows) {
      if (row.key in settings) {
        (settings as Record<string, string | null>)[row.key] = row.value;
      }

      if (!latestUpdatedAt || row.updatedAt > latestUpdatedAt) {
        latestUpdatedAt = row.updatedAt;
      }
    }

    settings.asrProvider = settings.asrProvider.trim() || defaults.asrProvider;
    settings.asrModel = normalizeAsrModel(settings.asrProvider, settings.asrModel);
    settings.llmProvider = normalizeLlmProvider(settings.llmProvider);
    settings.llmModel = normalizeLlmModel(settings.llmProvider, settings.llmModel);
    settings.updatedAt = latestUpdatedAt;
    return settings;
  }

  async getAppSettings(): Promise<AppSettingsRow> {
    const settings = this.getStoredAppSettings();
    const storePaths = getStorePaths();
    const [asrApiKeyMeta, llmApiKeyMeta] = await Promise.all([
      getSecureApiKeyMeta('asrApiKey'),
      getSecureApiKeyMeta('llmApiKey')
    ]);

    return {
      asrProvider: settings.asrProvider,
      asrModel: settings.asrModel,
      asrApiKeyConfigured: asrApiKeyMeta.configured,
      asrApiKeyPreview: asrApiKeyMeta.preview,
      llmProvider: settings.llmProvider,
      llmModel: settings.llmModel,
      llmApiKeyConfigured: llmApiKeyMeta.configured,
      llmApiKeyPreview: llmApiKeyMeta.preview,
      databasePath: storePaths.databasePath,
      imagesDirectoryPath: storePaths.imagesDir,
      updatedAt: settings.updatedAt
    };
  }

  async getRuntimeAppSettings(): Promise<RuntimeAppSettingsRow> {
    const settings = this.getStoredAppSettings();
    const [asrApiKey, llmApiKey] = await Promise.all([
      getSecureApiKey('asrApiKey'),
      getSecureApiKey('llmApiKey')
    ]);

    return {
      asrProvider: settings.asrProvider,
      asrModel: settings.asrModel,
      asrApiKey,
      llmProvider: settings.llmProvider,
      llmModel: settings.llmModel,
      llmApiKey,
      updatedAt: settings.updatedAt
    };
  }

  async saveAppSettings(payload: SaveAppSettingsPayload) {
    const timestamp = new Date().toISOString();
    const normalizedPayload = {
      asrProvider: payload.asrProvider.trim(),
      asrModel: normalizeAsrModel(payload.asrProvider, payload.asrModel),
      llmProvider: normalizeLlmProvider(payload.llmProvider),
      llmModel: normalizeLlmModel(payload.llmProvider, payload.llmModel)
    };

    Object.entries(normalizedPayload).forEach(([key, value]) => {
      this.db.run(
        'INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)',
        [key, value, timestamp]
      );
    });

    if (payload.clearAsrApiKey) {
      await deleteSecureApiKey('asrApiKey');
    } else if (payload.asrApiKeyInput?.trim()) {
      await setSecureApiKey('asrApiKey', payload.asrApiKeyInput);
    }

    if (payload.clearLlmApiKey) {
      await deleteSecureApiKey('llmApiKey');
    } else if (payload.llmApiKeyInput?.trim()) {
      await setSecureApiKey('llmApiKey', payload.llmApiKeyInput);
    }

    this.persist();
    return this.getAppSettings();
  }

  getSnapshot(): Snapshot {
    const notebooks = this.getRows<Snapshot['notebooks'][number]>(
      `SELECT notebooks.id,
              notebooks.name,
              notebooks.created_at AS createdAt,
              notebooks.updated_at AS updatedAt,
              COUNT(notes.id) AS noteCount
       FROM notebooks
       LEFT JOIN notes ON notes.notebook_id = notebooks.id
       GROUP BY notebooks.id
       ORDER BY notebooks.updated_at DESC`
    ).map((row) => ({
      ...row,
      noteCount: Number(row.noteCount)
    }));

    const notes = this.getRows<NoteRow>(
      `SELECT id,
              notebook_id AS notebookId,
              title,
              content_html AS contentHtml,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM notes
       ORDER BY updated_at DESC`
    );

    const transcriptSessions = this.getRows<TranscriptSessionRow>(
      `SELECT id,
              notebook_id AS notebookId,
              note_id AS noteId,
              title,
              status,
              source_type AS sourceType,
              language,
              provider,
              model,
              started_at AS startedAt,
              paused_at AS pausedAt,
              ended_at AS endedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM transcript_sessions
       ORDER BY updated_at DESC`
    );

    const transcriptSegments = this.getRows<TranscriptSegmentRow>(
      `SELECT id,
              session_id AS sessionId,
              note_id AS noteId,
              speaker_label AS speakerLabel,
              text,
              normalized_text AS normalizedText,
              start_ms AS startMs,
              end_ms AS endMs,
              duration_ms AS durationMs,
              is_final AS isFinal,
              sequence_no AS sequenceNo,
              confidence,
              raw_payload AS rawPayload,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM transcript_segments
       ORDER BY created_at ASC`
    );

    const aiAnalysisJobs = this.getRows<AiAnalysisJobRow>(
      `SELECT id,
              notebook_id AS notebookId,
              note_id AS noteId,
              session_id AS sessionId,
              analysis_type AS analysisType,
              status,
              provider,
              model,
              prompt_version AS promptVersion,
              input_hash AS inputHash,
              error_message AS errorMessage,
              started_at AS startedAt,
              finished_at AS finishedAt,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM ai_analysis_jobs
       ORDER BY created_at DESC`
    );

    const aiAnalysisResults = this.getRows<AiAnalysisResultRow>(
      `SELECT id,
              job_id AS jobId,
              result_type AS resultType,
              title,
              content_markdown AS contentMarkdown,
              content_json AS contentJson,
              sort_order AS sortOrder,
              created_at AS createdAt,
              updated_at AS updatedAt
       FROM ai_analysis_results
       ORDER BY created_at DESC, sort_order ASC`
    );

    return {
      notebooks,
      notes,
      transcriptSessions,
      transcriptSegments: transcriptSegments.map((segment) => ({
        ...segment,
        isFinal: Boolean(segment.isFinal)
      })),
      aiAnalysisJobs,
      aiAnalysisResults
    };
  }

  startTranscriptionSession(payload: {
    notebookId: string;
    noteId?: string | null;
    title?: string;
    language?: string;
    provider?: string;
    model?: string;
  }) {
    const timestamp = new Date().toISOString();
    const sessionId = randomUUID();
    const settings = this.getStoredAppSettings();

    this.closeActiveTranscriptionSessions('stopped', timestamp);
    this.db.run(
      `INSERT INTO transcript_sessions (
        id, notebook_id, note_id, title, status, source_type, language, provider,
        model, started_at, paused_at, ended_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sessionId,
        payload.notebookId,
        payload.noteId ?? null,
        payload.title?.trim() || `课堂实录 ${timestamp.slice(11, 16)}`,
        'recording',
        'system-audio',
        payload.language?.trim() || 'zh-CN',
        payload.provider?.trim() || settings.asrProvider,
        payload.model?.trim() || settings.asrModel,
        timestamp,
        null,
        null,
        timestamp,
        timestamp
      ]
    );

    this.touchNotebook(payload.notebookId, timestamp);
    this.persist();

    return this.getSnapshot();
  }

  appendTranscriptSegment(payload: {
    sessionId: string;
    noteId?: string | null;
    speakerLabel?: string | null;
    text: string;
    normalizedText?: string | null;
    startMs: number;
    endMs: number;
    durationMs: number;
    isFinal?: boolean;
    sequenceNo: number;
    confidence?: number | null;
    rawPayload?: string | null;
  }) {
    const session = this.getTranscriptSessionById(payload.sessionId);

    if (!session) {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    const targetNoteId = payload.noteId ?? session.noteId;

    this.insertTranscriptSegment({
      id: randomUUID(),
      sessionId: payload.sessionId,
      noteId: targetNoteId,
      speakerLabel: payload.speakerLabel ?? null,
      text: payload.text,
      normalizedText: payload.normalizedText ?? payload.text,
      startMs: payload.startMs,
      endMs: payload.endMs,
      durationMs: payload.durationMs,
      isFinal: payload.isFinal ? 1 : 0,
      sequenceNo: payload.sequenceNo,
      confidence: payload.confidence ?? null,
      rawPayload: payload.rawPayload ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    if (payload.isFinal && targetNoteId) {
      this.appendTranscriptToNote(targetNoteId, payload.text, timestamp);
    }

    this.db.run('UPDATE transcript_sessions SET updated_at = ? WHERE id = ?', [timestamp, payload.sessionId]);
    this.touchNotebook(session.notebookId, timestamp);
    this.persist();

    return this.getSnapshot();
  }

  pauseTranscriptionSession(sessionId: string) {
    const existing = this.getTranscriptSessionById(sessionId);

    if (!existing || existing.status !== 'recording') {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    this.db.run(
      'UPDATE transcript_sessions SET status = ?, paused_at = ?, updated_at = ? WHERE id = ?',
      ['paused', timestamp, timestamp, sessionId]
    );
    this.persist();

    return this.getSnapshot();
  }

  markTranscriptionSessionError(sessionId: string) {
    const existing = this.getTranscriptSessionById(sessionId);

    if (!existing) {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    this.db.run(
      'UPDATE transcript_sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?',
      ['error', timestamp, timestamp, sessionId]
    );
    this.deleteTranscriptSegmentsBySession(sessionId);
    this.db.run('VACUUM');
    this.persist();

    return this.getSnapshot();
  }

  resumeTranscriptionSession(sessionId: string) {
    const existing = this.getTranscriptSessionById(sessionId);

    if (!existing || existing.status !== 'paused') {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    this.closeActiveTranscriptionSessions('stopped', timestamp);
    this.db.run(
      'UPDATE transcript_sessions SET status = ?, paused_at = NULL, ended_at = NULL, updated_at = ? WHERE id = ?',
      ['recording', timestamp, sessionId]
    );
    this.persist();

    return this.getSnapshot();
  }

  stopTranscriptionSession(sessionId: string) {
    const existing = this.getTranscriptSessionById(sessionId);

    if (!existing || !['recording', 'paused'].includes(existing.status)) {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    this.db.run(
      'UPDATE transcript_sessions SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?',
      ['stopped', timestamp, timestamp, sessionId]
    );
    this.deleteTranscriptSegmentsBySession(sessionId);
    this.db.run('VACUUM');
    this.persist();

    return this.getSnapshot();
  }

  async createAiAnalysisJob(payload: {
    notebookId: string;
    noteId?: string | null;
    sessionId?: string | null;
    analysisType: AiAnalysisType;
  }) {
    const timestamp = new Date().toISOString();
    const jobId = randomUUID();
    const settings = this.getStoredAppSettings();
    const sourceText = this.getAnalysisSourceText(payload.noteId ?? null, payload.sessionId ?? null);
    const displayTitle = this.getAnalysisDisplayTitle(payload.noteId ?? null, payload.sessionId ?? null);

    this.insertAiAnalysisJob({
      id: jobId,
      notebookId: payload.notebookId,
      noteId: payload.noteId ?? null,
      sessionId: payload.sessionId ?? null,
      analysisType: payload.analysisType,
      status: 'running',
      provider: settings.llmProvider,
      model: settings.llmModel,
      promptVersion: 'stage3-v1',
      inputHash: `${payload.analysisType}:${sourceText.length}`,
      errorMessage: null,
      startedAt: timestamp,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    this.persist();

    const runtimeSettings = await this.getRuntimeAppSettings();

    return {
      jobId,
      sourceText,
      displayTitle,
      provider: settings.llmProvider,
      model: settings.llmModel,
      apiKey: runtimeSettings.llmApiKey
    };
  }

  completeAiAnalysisJob(payload: {
    jobId: string;
    notebookId: string;
    analysisType: AiAnalysisType;
    resultBlocks: AiAnalysisResultBlock[];
  }) {
    const timestamp = new Date().toISOString();

    payload.resultBlocks.forEach((block, index) => {
      this.insertAiAnalysisResult({
        id: randomUUID(),
        jobId: payload.jobId,
        resultType: payload.analysisType,
        title: block.title,
        contentMarkdown: block.contentMarkdown,
        contentJson: null,
        sortOrder: index,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    });

    this.db.run(
      'UPDATE ai_analysis_jobs SET status = ?, finished_at = ?, updated_at = ? WHERE id = ?',
      ['completed', timestamp, timestamp, payload.jobId]
    );
    this.touchNotebook(payload.notebookId, timestamp);
    this.persist();

    return this.getSnapshot();
  }

  failAiAnalysisJob(payload: { jobId: string; notebookId: string; message: string }) {
    const timestamp = new Date().toISOString();
    this.db.run(
      'UPDATE ai_analysis_jobs SET status = ?, error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?',
      ['failed', payload.message, timestamp, timestamp, payload.jobId]
    );
    this.touchNotebook(payload.notebookId, timestamp);
    this.persist();

    return this.getSnapshot();
  }

  deleteAiAnalysisJob(jobId: string) {
    const existingJob = this.getAiAnalysisJobById(jobId);

    if (!existingJob) {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    this.db.run('DELETE FROM ai_analysis_jobs WHERE id = ?', [jobId]);
    this.touchNotebook(existingJob.notebookId, timestamp);
    this.persist();

    return this.getSnapshot();
  }

  saveAiAnalysisAsNote(jobId: string, customTitle?: string | null): SaveAiAnalysisAsNoteResult {
    const existingJob = this.getAiAnalysisJobById(jobId);

    if (!existingJob) {
      throw new Error('未找到要保存的 AI 分析任务。');
    }

    const resultBlocks = this.getAiAnalysisResultsByJobId(jobId);

    if (resultBlocks.length === 0) {
      throw new Error('当前 AI 分析还没有可保存的结果内容。');
    }

    const timestamp = new Date().toISOString();
    const noteId = randomUUID();
    const sourceTitle = this.getAnalysisDisplayTitle(existingJob.noteId, existingJob.sessionId);
    const analysisLabel = getAiAnalysisTypeLabel(existingJob.analysisType);
    const noteTitle = customTitle?.trim() || `${sourceTitle} - AI${analysisLabel}`;
    const contentHtml = [
      `<h2>${escapeHtml(noteTitle)}</h2>`,
      `<p>来源：${escapeHtml(sourceTitle)}</p>`,
      ...resultBlocks.map(
        (result) =>
          `<section><h3>${escapeHtml(result.title)}</h3>${renderMarkdownToHtml(result.contentMarkdown)}</section>`
      )
    ].join('');

    this.insertNote({
      id: noteId,
      notebookId: existingJob.notebookId,
      title: noteTitle,
      contentHtml,
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.touchNotebook(existingJob.notebookId, timestamp);
    this.persist();

    return {
      snapshot: this.getSnapshot(),
      noteId
    };
  }

  createNotebook(name: string) {
    const timestamp = new Date().toISOString();

    this.insertNotebook({
      id: randomUUID(),
      name: name.trim() || '未命名课程',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.persist();

    return this.getSnapshot();
  }

  renameNotebook(notebookId: string, name: string) {
    this.db.run('UPDATE notebooks SET name = ?, updated_at = ? WHERE id = ?', [
      name.trim() || '未命名课程',
      new Date().toISOString(),
      notebookId
    ]);
    this.persist();

    return this.getSnapshot();
  }

  deleteNotebook(notebookId: string) {
    const noteRows = this.getRows<{ contentHtml: string }>(
      'SELECT content_html AS contentHtml FROM notes WHERE notebook_id = ?',
      [notebookId]
    );
    const candidates = noteRows.flatMap((row) => extractManagedImagePaths(row.contentHtml, this.paths.imagesDir));

    this.db.run('DELETE FROM notebooks WHERE id = ?', [notebookId]);

    if (this.getScalarNumber('SELECT COUNT(*) AS count FROM notebooks') === 0) {
      const timestamp = new Date().toISOString();
      this.insertNotebook({
        id: randomUUID(),
        name: '默认课程',
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    this.persist();
    this.cleanupUnusedImages(candidates);

    return this.getSnapshot();
  }

  createNote(notebookId: string) {
    const timestamp = new Date().toISOString();

    this.insertNote({
      id: randomUUID(),
      notebookId,
      title: '新建笔记',
      contentHtml: '<p></p>',
      createdAt: timestamp,
      updatedAt: timestamp
    });
    this.touchNotebook(notebookId, timestamp);
    this.persist();

    return this.getSnapshot();
  }

  async updateNote(noteId: string, title: string, contentHtml: string) {
    const existingNote = this.getNoteById(noteId);

    if (!existingNote) {
      return this.getSnapshot();
    }

    const timestamp = new Date().toISOString();
    const normalizedHtml = sanitizeNoteHtml(
      await replaceDataUrlsWithFiles(contentHtml, (dataUrl) =>
        this.persistImageDataUrl(dataUrl, `${noteId}.png`)
      )
    );

    this.db.run(
      'UPDATE notes SET title = ?, content_html = ?, updated_at = ? WHERE id = ?',
      [title.trim() || '未命名笔记', normalizedHtml, timestamp, noteId]
    );
    this.touchNotebook(existingNote.notebookId, timestamp);
    this.persist();

    const previousImages = extractManagedImagePaths(existingNote.contentHtml, this.paths.imagesDir);
    this.cleanupUnusedImages(previousImages, noteId);

    return this.getSnapshot();
  }

  deleteNote(noteId: string) {
    const existingNote = this.getNoteById(noteId);

    if (!existingNote) {
      return this.getSnapshot();
    }

    this.db.run('DELETE FROM notes WHERE id = ?', [noteId]);
    this.touchNotebook(existingNote.notebookId, new Date().toISOString());
    this.persist();

    const previousImages = extractManagedImagePaths(existingNote.contentHtml, this.paths.imagesDir);
    this.cleanupUnusedImages(previousImages, noteId);

    return this.getSnapshot();
  }

  persistImageDataUrl(dataUrl: string, originalName?: string) {
    const { mimeType, buffer } = parseDataUrl(dataUrl);
    const extension = guessExtension(mimeType, originalName);
    const filePath = path.join(this.paths.imagesDir, `${randomUUID()}.${extension}`);

    fs.writeFileSync(filePath, buffer);
    return pathToFileURL(filePath).toString();
  }
}

export async function getDatabaseStore() {
  storePromise ??= DatabaseStore.create();
  return storePromise;
}
