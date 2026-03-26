import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import dayjs from 'dayjs';
import { EditorContent, useEditor } from '@tiptap/react';
import { Extension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Color from '@tiptap/extension-color';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import Table from '@tiptap/extension-table';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import TextStyle from '@tiptap/extension-text-style';
import type {
  AiAnalysisJobRecord,
  AiAnalysisResultRecord,
  AiAnalysisType,
  AppSettings,
  ExportPdfResult,
  NoteRecord,
  NotebookSummary,
  SaveAppSettingsPayload,
  SaveAiAnalysisAsNoteResult,
  Snapshot,
  TranscriptionRuntimeState,
  TranscriptSegmentRecord,
  TranscriptSessionRecord
} from './types';
import appIcon from '../icon-for-app.png';

const SIDEBAR_WIDTH_KEY = 'aicoursenote.sidebar-width';
const NOTE_STRIP_HEIGHT_KEY = 'aicoursenote.note-strip-height';
const NOTE_STRIP_COLLAPSED_KEY = 'aicoursenote.note-strip-collapsed';
const EDITOR_COLLAPSED_KEY = 'aicoursenote.editor-collapsed';
const MIN_SIDEBAR_WIDTH = 240;
const MAX_SIDEBAR_WIDTH = 460;
const DEFAULT_SIDEBAR_WIDTH = 300;
const MIN_NOTE_STRIP_HEIGHT = 220;
const MAX_NOTE_STRIP_HEIGHT = 620;
const DEFAULT_NOTE_STRIP_HEIGHT = 300;
const ASSISTANT_EXPANDED_HEIGHT = 460;
const COLLAPSED_SECTION_HEIGHT = 88;
const DEFAULT_TEXT_COLOR = '#14263f';
const DEFAULT_FONT_SIZE = '16px';
const COLOR_SWATCHES = ['#14263f', '#2388ff', '#0d9488', '#f97316', '#e11d48', '#7c3aed'];
const FONT_SIZE_OPTIONS = ['14px', '16px', '18px', '20px', '24px', '30px'];

type ModelPreset = {
  value: string;
  label: string;
  description: string;
};

type ProviderPreset = {
  value: string;
  label: string;
  description: string;
  models: ModelPreset[];
};

type DiagnosticLogEntry = {
  id: string;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  timestamp: string;
};

type NotebookDialogState = {
  open: boolean;
  mode: 'create' | 'rename';
  notebookId: string;
  name: string;
};

type AiNoteSaveDialogState = {
  open: boolean;
  jobId: string;
  notebookId: string;
  title: string;
};

const LIVE_TRANSCRIPT_PARAGRAPH_PATTERN = /<p data-live-transcript="true">[\s\S]*?<\/p>/g;

function escapeHtmlText(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function appendTranscriptParagraph(html: string, text: string) {
  const escaped = escapeHtmlText(text);
  const base = removeLiveTranscriptParagraph(html || '<p></p>');
  return `${base}<p>${escaped}</p>`;
}

function upsertLiveTranscriptParagraph(html: string, text: string) {
  const escaped = escapeHtmlText(text);
  const preview = `<p data-live-transcript="true"><span style="color:#5f7089;">${escaped}</span></p>`;
  const base = html || '<p></p>';

  LIVE_TRANSCRIPT_PARAGRAPH_PATTERN.lastIndex = 0;

  if (LIVE_TRANSCRIPT_PARAGRAPH_PATTERN.test(base)) {
    LIVE_TRANSCRIPT_PARAGRAPH_PATTERN.lastIndex = 0;
    return base.replace(LIVE_TRANSCRIPT_PARAGRAPH_PATTERN, preview);
  }

  return `${base}${preview}`;
}

function removeLiveTranscriptParagraph(html: string) {
  LIVE_TRANSCRIPT_PARAGRAPH_PATTERN.lastIndex = 0;
  const next = (html || '<p></p>').replace(LIVE_TRANSCRIPT_PARAGRAPH_PATTERN, '');
  return next.trim() ? next : '<p></p>';
}

function normalizeRichTextHtml(html: string) {
  const source = (html || '<p></p>').trim();

  if (typeof document === 'undefined') {
    return source;
  }

  const container = document.createElement('div');
  container.innerHTML = source;
  return container.innerHTML.trim();
}

function ensureEditableRichTextHtml(html: string) {
  const source = (html || '<p></p>').trim();

  if (typeof document === 'undefined') {
    return source || '<p></p>';
  }

  const container = document.createElement('div');
  container.innerHTML = source || '<p></p>';

  if (!container.innerHTML.trim()) {
    container.innerHTML = '<p></p>';
  }

  const lastElement = container.lastElementChild;

  if (!lastElement || !['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE'].includes(lastElement.tagName)) {
    const paragraph = document.createElement('p');
    container.appendChild(paragraph);
  }

  return container.innerHTML.trim() || '<p></p>';
}

const ASR_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    value: 'dashscope-asr',
    label: 'Qwen ASR',
    description: '阿里云百炼实时语音转写',
    models: [
      {
        value: 'qwen3-asr-flash-realtime',
        label: 'qwen3-asr-flash-realtime',
        description: '当前预置的课堂系统音频实时转写模型'
      }
    ]
  }
];

const LLM_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    value: 'deepseek',
    label: 'DeepSeek',
    description: 'DeepSeek OpenAI 兼容接口',
    models: [
      {
        value: 'deepseek-chat',
        label: 'deepseek-chat',
        description: '通用对话模型，适合作为默认 AI 分析模型'
      },
      {
        value: 'deepseek-reasoner',
        label: 'deepseek-reasoner',
        description: '更强调推理过程的模型，适合复杂分析场景'
      }
    ]
  }
];

const DEFAULT_ASR_PROVIDER = ASR_PROVIDER_PRESETS[0].value;
const DEFAULT_ASR_MODEL = ASR_PROVIDER_PRESETS[0].models[0].value;
const DEFAULT_LLM_PROVIDER = LLM_PROVIDER_PRESETS[0].value;
const DEFAULT_LLM_MODEL = LLM_PROVIDER_PRESETS[0].models[0].value;

const DEFAULT_APP_SETTINGS: AppSettings = {
  asrProvider: DEFAULT_ASR_PROVIDER,
  asrModel: DEFAULT_ASR_MODEL,
  asrApiKeyConfigured: false,
  asrApiKeyPreview: null,
  llmProvider: DEFAULT_LLM_PROVIDER,
  llmModel: DEFAULT_LLM_MODEL,
  llmApiKeyConfigured: false,
  llmApiKeyPreview: null,
  databasePath: '',
  imagesDirectoryPath: '',
  updatedAt: null
};

type SettingsDraft = AppSettings & {
  asrApiKeyInput: string;
  llmApiKeyInput: string;
  clearAsrApiKey: boolean;
  clearLlmApiKey: boolean;
};

function getProviderPreset(presets: ProviderPreset[], providerValue: string) {
  return presets.find((preset) => preset.value === providerValue) ?? presets[0];
}

function normalizeProviderModelSelection(
  presets: ProviderPreset[],
  providerValue: string,
  modelValue: string
) {
  const provider = getProviderPreset(presets, providerValue);
  const model = provider.models.find((item) => item.value === modelValue) ?? provider.models[0];

  return {
    provider: provider.value,
    model: model.value
  };
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const asr = normalizeProviderModelSelection(ASR_PROVIDER_PRESETS, settings.asrProvider, settings.asrModel);
  const llm = normalizeProviderModelSelection(LLM_PROVIDER_PRESETS, settings.llmProvider, settings.llmModel);

  return {
    ...settings,
    asrProvider: asr.provider,
    asrModel: asr.model,
    llmProvider: llm.provider,
    llmModel: llm.model
  };
}

function createSettingsDraft(settings: AppSettings): SettingsDraft {
  return {
    ...settings,
    asrApiKeyInput: '',
    llmApiKeyInput: '',
    clearAsrApiKey: false,
    clearLlmApiKey: false
  };
}

const FontSize = Extension.create({
  name: 'fontSize',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => element.style.fontSize || null,
            renderHTML: (attributes) => {
              if (!attributes.fontSize) {
                return {};
              }

              return {
                style: `font-size: ${attributes.fontSize}`
              };
            }
          }
        }
      }
    ];
  }
});

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getStoredNumber(key: string, fallback: number) {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);
  const parsed = Number(raw);

  return Number.isFinite(parsed) ? parsed : fallback;
}

function getStoredBoolean(key: string, fallback = false) {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const raw = window.localStorage.getItem(key);

  if (raw === null) {
    return fallback;
  }

  return raw === 'true';
}

function stripHtml(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatTime(value: string) {
  return dayjs(value).format('MM-DD HH:mm');
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getAccentColor(seed: string) {
  const palette = ['#2388ff', '#0d9488', '#7c3aed', '#f97316', '#e11d48', '#2563eb'];
  const hash = seed.split('').reduce((total, char) => total + char.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

function getShortName(name: string) {
  const trimmed = name.trim();

  if (!trimmed) {
    return '课';
  }

  return trimmed.length === 1 ? trimmed : trimmed.slice(0, 2);
}

function getTranscriptStatusLabel(status: TranscriptSessionRecord['status']) {
  switch (status) {
    case 'recording':
      return '转写中';
    case 'paused':
      return '已暂停';
    case 'stopped':
      return '已停止';
    case 'error':
      return '异常';
    default:
      return '空闲';
  }
}

function getAnalysisTypeLabel(type: AiAnalysisType) {
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

function getAnalysisJobStatusLabel(status: AiAnalysisJobRecord['status']) {
  switch (status) {
    case 'pending':
      return '等待中';
    case 'running':
      return '生成中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
  }
}

function maskApiKey(value: string) {
  if (!value) {
    return '未填写';
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}****`;
  }

  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

type SettingsModalProps = {
  open: boolean;
  draft: SettingsDraft;
  saving: boolean;
  onClose: () => void;
  onFieldChange: (
    field: 'asrProvider' | 'asrModel' | 'llmProvider' | 'llmModel' | 'asrApiKeyInput' | 'llmApiKeyInput',
    value: string
  ) => void;
  onToggleClear: (field: 'clearAsrApiKey' | 'clearLlmApiKey') => void;
  onSave: () => void;
};

function SettingsModal({ open, draft, saving, onClose, onFieldChange, onToggleClear, onSave }: SettingsModalProps) {
  if (!open) {
    return null;
  }

  const asrProvider = getProviderPreset(ASR_PROVIDER_PRESETS, draft.asrProvider);
  const asrModel = asrProvider.models.find((item) => item.value === draft.asrModel) ?? asrProvider.models[0];
  const llmProvider = getProviderPreset(LLM_PROVIDER_PRESETS, draft.llmProvider);
  const llmModel = llmProvider.models.find((item) => item.value === draft.llmModel) ?? llmProvider.models[0];

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="应用设置">
      <div className="settings-modal">
        <header className="settings-modal-header">
          <div>
            <div className="section-caption">设置</div>
            <h3>模型与 API 配置</h3>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-grid">
          <section className="settings-section">
            <h4>语音转写</h4>
            <label className="settings-field">
              <span>语音服务商</span>
              <select value={asrProvider.value} onChange={(event) => onFieldChange('asrProvider', event.target.value)}>
                {ASR_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-inline-meta">{asrProvider.description}</div>
            <label className="settings-field">
              <span>语音模型</span>
              <select value={asrModel.value} onChange={(event) => onFieldChange('asrModel', event.target.value)}>
                {asrProvider.models.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-inline-meta">{asrModel.description}</div>
            <label className="settings-field">
              <span>ASR API Key</span>
              <input
                type="password"
                value={draft.asrApiKeyInput}
                onChange={(event) => onFieldChange('asrApiKeyInput', event.target.value)}
                placeholder={draft.asrApiKeyConfigured ? '留空则保留现有 key，输入则替换' : '填入语音转写服务 API key'}
              />
            </label>
            <div className="settings-inline-meta">
              当前状态：
              {draft.clearAsrApiKey
                ? '将清除已保存 key'
                : draft.asrApiKeyConfigured
                  ? `已保存 ${draft.asrApiKeyPreview ?? ''}`
                  : '未保存'}
            </div>
            <div className="settings-inline-actions">
              <button
                className={draft.clearAsrApiKey ? 'ghost-button active-toggle' : 'ghost-button'}
                type="button"
                onClick={() => onToggleClear('clearAsrApiKey')}
                disabled={!draft.asrApiKeyConfigured && !draft.clearAsrApiKey}
              >
                {draft.clearAsrApiKey ? '撤销清除' : '清除已存 Key'}
              </button>
            </div>
            <div className="settings-field-hint">当前阶段已预置好 Qwen 实时 ASR。完整 key 只保存在系统安全存储中，这里只显示状态和掩码预览。</div>
          </section>

          <section className="settings-section">
            <h4>大语言模型</h4>
            <label className="settings-field">
              <span>模型服务商</span>
              <select value={llmProvider.value} onChange={(event) => onFieldChange('llmProvider', event.target.value)}>
                {LLM_PROVIDER_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-inline-meta">{llmProvider.description}</div>
            <label className="settings-field">
              <span>模型名称</span>
              <select value={llmModel.value} onChange={(event) => onFieldChange('llmModel', event.target.value)}>
                {llmProvider.models.map((model) => (
                  <option key={model.value} value={model.value}>
                    {model.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="settings-inline-meta">{llmModel.description}</div>
            <label className="settings-field">
              <span>LLM API Key</span>
              <input
                type="password"
                value={draft.llmApiKeyInput}
                onChange={(event) => onFieldChange('llmApiKeyInput', event.target.value)}
                placeholder={draft.llmApiKeyConfigured ? '留空则保留现有 key，输入则替换' : '填入大模型 API key'}
              />
            </label>
            <div className="settings-inline-meta">
              当前状态：
              {draft.clearLlmApiKey
                ? '将清除已保存 key'
                : draft.llmApiKeyConfigured
                  ? `已保存 ${draft.llmApiKeyPreview ?? ''}`
                  : '未保存'}
            </div>
            <div className="settings-inline-actions">
              <button
                className={draft.clearLlmApiKey ? 'ghost-button active-toggle' : 'ghost-button'}
                type="button"
                onClick={() => onToggleClear('clearLlmApiKey')}
                disabled={!draft.llmApiKeyConfigured && !draft.clearLlmApiKey}
              >
                {draft.clearLlmApiKey ? '撤销清除' : '清除已存 Key'}
              </button>
            </div>
            <div className="settings-field-hint">完整 key 只保存在系统安全存储中，这里只负责查看状态、替换新 key 或清除已存 key。</div>
          </section>

          <section className="settings-section settings-section-wide">
            <h4>本地数据位置</h4>
            <div className="settings-inline-meta">当前这份程序实际连接的是下面这份本地数据库。</div>
            <label className="settings-field">
              <span>数据库路径</span>
              <textarea className="settings-readonly-block" value={draft.databasePath} readOnly rows={3} />
            </label>
            <label className="settings-field">
              <span>图片目录</span>
              <textarea className="settings-readonly-block" value={draft.imagesDirectoryPath} readOnly rows={3} />
            </label>
            <div className="settings-field-hint">如果你同时运行多个 AICourseNote 目录版，可以通过这里快速确认当前窗口正在使用哪一个 data 目录。</div>
          </section>
        </div>

        <footer className="settings-modal-footer">
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={onSave} disabled={saving}>
            {saving ? '保存中...' : '保存设置'}
          </button>
        </footer>
      </div>
    </div>
  );
}

type NotebookModalProps = {
  state: NotebookDialogState;
  saving: boolean;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onSubmit: () => void;
};

function NotebookModal({ state, saving, onClose, onNameChange, onSubmit }: NotebookModalProps) {
  if (!state.open) {
    return null;
  }

  const isCreate = state.mode === 'create';

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label={isCreate ? '新建课程' : '重命名课程'}>
      <form
        className="notebook-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <header className="settings-modal-header">
          <div>
            <div className="section-caption">课程管理</div>
            <h3>{isCreate ? '新建课程' : '重命名课程'}</h3>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="notebook-modal-body">
          <label className="settings-field">
            <span>课程名称</span>
            <input
              autoFocus
              type="text"
              value={state.name}
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="例如：高等数学 / 计算机网络"
              maxLength={60}
            />
          </label>
          <div className="settings-field-hint">课程名称会显示在左侧列表和课堂助手标题中，建议保持简短清晰。</div>
        </div>

        <footer className="settings-modal-footer">
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving || !state.name.trim()}>
            {saving ? '保存中...' : isCreate ? '创建课程' : '保存修改'}
          </button>
        </footer>
      </form>
    </div>
  );
}

type AiNoteSaveModalProps = {
  state: AiNoteSaveDialogState;
  saving: boolean;
  onClose: () => void;
  onTitleChange: (value: string) => void;
  onSubmit: () => void;
};

function AiNoteSaveModal({ state, saving, onClose, onTitleChange, onSubmit }: AiNoteSaveModalProps) {
  if (!state.open) {
    return null;
  }

  return (
    <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="保存 AI 结果为新笔记">
      <form
        className="notebook-modal"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <header className="settings-modal-header">
          <div>
            <div className="section-caption">AI 结果保存</div>
            <h3>保存为新笔记</h3>
          </div>
          <button className="ghost-button" type="button" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="notebook-modal-body">
          <label className="settings-field">
            <span>新笔记标题</span>
            <input
              autoFocus
              type="text"
              value={state.title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="输入要保存的新笔记标题"
              maxLength={80}
            />
          </label>
          <div className="settings-field-hint">这一步只会新建一条笔记用于保存 AI 结果，不会修改当前原始笔记内容。</div>
        </div>

        <footer className="settings-modal-footer">
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving || !state.title.trim()}>
            {saving ? '保存中...' : '创建新笔记'}
          </button>
        </footer>
      </form>
    </div>
  );
}

type ErrorLogModalProps = {
  entries: DiagnosticLogEntry[];
  open: boolean;
  onClose: () => void;
  onClear: () => void;
};

function ErrorLogModal({ entries, open, onClose, onClear }: ErrorLogModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className="error-log-overlay" role="dialog" aria-modal="true" aria-label="错误日志">
      <div className="error-log-modal">
        <header className="error-log-header">
          <div>
            <div className="section-caption">错误日志</div>
            <h3>仅保留报错信息</h3>
          </div>
          <div className="error-log-actions">
            <button className="ghost-button error-log-button" type="button" onClick={onClear}>
              清空日志
            </button>
            <button className="ghost-button error-log-button" type="button" onClick={onClose}>
              关闭窗口
            </button>
          </div>
        </header>

        <div className="error-log-hint">错误日志只保存在当前运行内存中，不写入本地文件，关闭程序后会自动清空。</div>

        <div className="error-log-list">
          {entries.length > 0 ? (
            entries.map((entry) => (
              <article key={entry.id} className="error-log-item">
                <div className="error-log-meta">
                  <span>ERROR</span>
                  <span>{formatTime(entry.timestamp)}</span>
                </div>
                <div className="error-log-message">{entry.message}</div>
              </article>
            ))
          ) : (
            <div className="error-log-empty">当前还没有错误日志。发生采集错误或转写错误时，这里才会出现记录。</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ErrorLogLauncher({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button className="error-log-launcher" type="button" onClick={onOpen}>
      查看错误日志
      <span className="error-log-badge">{count}</span>
    </button>
  );
}

type AssistantPanelProps = {
  notebook: NotebookSummary | null;
  note: NoteRecord | null;
  runtimeState: TranscriptionRuntimeState;
  liveTranscriptText: string;
  settings: AppSettings;
  transcriptSessions: TranscriptSessionRecord[];
  transcriptSegments: TranscriptSegmentRecord[];
  aiAnalysisJobs: AiAnalysisJobRecord[];
  aiAnalysisResults: AiAnalysisResultRecord[];
  onOpenSettings: () => void;
  onStartTranscription: () => void;
  onPauseTranscription: (sessionId: string) => void;
  onResumeTranscription: (sessionId: string) => void;
  onStopTranscription: (sessionId: string) => void;
  onCreateAiAnalysis: (analysisType: AiAnalysisType) => void;
  onDeleteAiAnalysis: (job: AiAnalysisJobRecord) => void;
  onSaveAiAnalysisAsNote: (job: AiAnalysisJobRecord) => void;
};

function AssistantPanel({
  notebook,
  note,
  runtimeState,
  liveTranscriptText,
  settings,
  transcriptSessions,
  transcriptSegments,
  aiAnalysisJobs,
  aiAnalysisResults,
  onOpenSettings,
  onStartTranscription,
  onPauseTranscription,
  onResumeTranscription,
  onStopTranscription,
  onCreateAiAnalysis,
  onDeleteAiAnalysis,
  onSaveAiAnalysisAsNote
}: AssistantPanelProps) {
  const [activeTab, setActiveTab] = useState<'transcript' | 'ai'>('transcript');
  const [transcriptActionGroup, setTranscriptActionGroup] = useState<'controls' | 'views' | null>('controls');
  const [transcriptView, setTranscriptView] = useState<'segments' | 'runtime'>('segments');
  const [aiActionGroup, setAiActionGroup] = useState<'generate' | 'results' | null>('generate');

  const notebookSessions = useMemo(
    () => transcriptSessions.filter((session) => session.notebookId === notebook?.id),
    [notebook?.id, transcriptSessions]
  );

  const activeSession =
    notebookSessions.find((session) => session.status === 'recording' || session.status === 'paused') ||
    notebookSessions[0] ||
    null;

  const sessionSegments = useMemo(
    () =>
      activeSession
        ? transcriptSegments.filter((segment) => segment.sessionId === activeSession.id && segment.isFinal)
        : [],
    [activeSession, transcriptSegments]
  );

  const scopedJobs = useMemo(
    () =>
      aiAnalysisJobs.filter((job) => {
        if (job.notebookId !== notebook?.id) {
          return false;
        }

        if (note && job.noteId === note.id) {
          return true;
        }

        if (activeSession && job.sessionId === activeSession.id) {
          return true;
        }

        return !note && !activeSession;
      }),
    [activeSession, aiAnalysisJobs, notebook?.id, note]
  );

  const scopedJobIds = new Set(scopedJobs.map((job) => job.id));
  const scopedResults = aiAnalysisResults.filter((result) => scopedJobIds.has(result.jobId));
  const isRecording = activeSession?.status === 'recording';
  const isPaused = activeSession?.status === 'paused';

  return (
    <section className="assistant-panel">
      <header className="assistant-panel-header">
        <div>
          <div className="section-caption">课堂助手</div>
          <h3>{notebook ? `${notebook.name} 的转写与 AI 辅助` : '课堂助手'}</h3>
        </div>
        <div className="assistant-tab-group">
          <button
            className={activeTab === 'transcript' ? 'assistant-tab active' : 'assistant-tab'}
            type="button"
            onClick={() => setActiveTab('transcript')}
          >
            实时转写
          </button>
          <button
            className={activeTab === 'ai' ? 'assistant-tab active' : 'assistant-tab'}
            type="button"
            onClick={() => setActiveTab('ai')}
          >
            AI 分析
          </button>
        </div>
      </header>

      <div className="assistant-context-row">
        <div className="assistant-context-card">
          <span className="assistant-context-label">当前课程</span>
          <strong>{notebook?.name ?? '未选择课程'}</strong>
        </div>
        <div className="assistant-context-card">
          <span className="assistant-context-label">绑定笔记</span>
          <strong>{note?.title ?? '未绑定，结果仅保存在会话侧'}</strong>
        </div>
        <div className="assistant-context-card compact">
          <span className="assistant-context-label">最近状态</span>
          <strong>{activeSession ? getTranscriptStatusLabel(activeSession.status) : '未开始'}</strong>
        </div>
      </div>

      <button className="assistant-settings-banner" type="button" onClick={onOpenSettings}>
        <div>
          <div className="assistant-settings-title">API 与模型设置</div>
          <div className="assistant-settings-subtitle">
            ASR {settings.asrApiKeyConfigured ? '已配置' : '未配置'} / LLM {settings.llmApiKeyConfigured ? '已配置' : '未配置'}
          </div>
        </div>
        <span className="assistant-settings-action">打开设置</span>
      </button>

      {activeTab === 'transcript' ? (
        <div className="assistant-panel-body">
          <div className="assistant-action-dock">
            <div className="assistant-action-menu-row">
              <button
                className={transcriptActionGroup === 'controls' ? 'ghost-button assistant-menu-trigger active' : 'ghost-button assistant-menu-trigger'}
                type="button"
                onClick={() => setTranscriptActionGroup((current) => (current === 'controls' ? null : 'controls'))}
              >
                转写控制
              </button>
              <button
                className={transcriptActionGroup === 'views' ? 'ghost-button assistant-menu-trigger active' : 'ghost-button assistant-menu-trigger'}
                type="button"
                onClick={() => setTranscriptActionGroup((current) => (current === 'views' ? null : 'views'))}
              >
                查看内容
              </button>
            </div>

            {transcriptActionGroup === 'controls' ? (
              <div className="assistant-action-panel">
                <button className="primary-button" type="button" onClick={onStartTranscription} disabled={!notebook}>
                  开始转写
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => activeSession && onPauseTranscription(activeSession.id)}
                  disabled={!isRecording}
                >
                  暂停
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => activeSession && onResumeTranscription(activeSession.id)}
                  disabled={!isPaused}
                >
                  继续
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => activeSession && onStopTranscription(activeSession.id)}
                  disabled={!activeSession || activeSession.status === 'stopped'}
                >
                  停止
                </button>
                <span className={activeSession ? `assistant-status-chip ${activeSession.status}` : 'assistant-status-chip'}>
                  {activeSession ? getTranscriptStatusLabel(activeSession.status) : '等待开始'}
                </span>
              </div>
            ) : null}

            {transcriptActionGroup === 'views' ? (
              <div className="assistant-action-panel compact">
                <button
                  className={transcriptView === 'segments' ? 'ghost-button assistant-view-button active' : 'ghost-button assistant-view-button'}
                  type="button"
                  onClick={() => setTranscriptView('segments')}
                >
                  转写片段
                </button>
                <button
                  className={transcriptView === 'runtime' ? 'ghost-button assistant-view-button active' : 'ghost-button assistant-view-button'}
                  type="button"
                  onClick={() => setTranscriptView('runtime')}
                >
                  运行状态
                </button>
              </div>
            ) : null}
          </div>

          {runtimeState.lastError ? <div className="assistant-runtime-error">采集错误：{runtimeState.lastError}</div> : null}
          {runtimeState.asrLastError ? <div className="assistant-runtime-error">ASR 错误：{runtimeState.asrLastError}</div> : null}
          {runtimeState.asrLastMessagePreview ? (
            <div className="assistant-runtime-debug">最近 ASR 消息：{runtimeState.asrLastMessagePreview}</div>
          ) : null}

          {transcriptView === 'runtime' ? (
            <div className="assistant-runtime-grid">
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">采集阶段</span>
                <strong>{runtimeState.phase}</strong>
              </div>
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">音频块数</span>
                <strong>{runtimeState.chunkCount}</strong>
              </div>
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">采样率</span>
                <strong>{runtimeState.sampleRate ?? '--'}</strong>
              </div>
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">最近峰值</span>
                <strong>{runtimeState.lastPeak !== null ? runtimeState.lastPeak.toFixed(3) : '--'}</strong>
              </div>
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">ASR 连接</span>
                <strong>{runtimeState.asrConnectionState ?? '--'}</strong>
              </div>
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">ASR 收包数</span>
                <strong>{runtimeState.asrReceivedMessageCount ?? 0}</strong>
              </div>
              <div className="assistant-runtime-card">
                <span className="assistant-context-label">ASR 最近事件</span>
                <strong>{runtimeState.asrLastEventType ?? '--'}</strong>
              </div>
            </div>
          ) : null}

          {transcriptView === 'segments' ? (
            <div className="assistant-segment-list">
              {liveTranscriptText ? (
                <div className="assistant-segment-item pending">
                  <div className="assistant-segment-time">实时识别中</div>
                  <div className="assistant-segment-text">{liveTranscriptText}</div>
                </div>
              ) : null}

              {sessionSegments.length > 0 ? (
                sessionSegments.map((segment) => (
                  <div key={segment.id} className="assistant-segment-item">
                    <div className="assistant-segment-time">
                      {(segment.startMs / 1000).toFixed(0)}s - {(segment.endMs / 1000).toFixed(0)}s
                    </div>
                    <div className="assistant-segment-text">{segment.text}</div>
                  </div>
                ))
              ) : (
                <div className="assistant-empty-state">暂无转写片段。</div>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="assistant-panel-body">
          <div className="assistant-action-dock">
            <div className="assistant-action-menu-row">
              <button
                className={aiActionGroup === 'generate' ? 'ghost-button assistant-menu-trigger active' : 'ghost-button assistant-menu-trigger'}
                type="button"
                onClick={() => setAiActionGroup((current) => (current === 'generate' ? null : 'generate'))}
              >
                生成功能
              </button>
              <button
                className={aiActionGroup === 'results' ? 'ghost-button assistant-menu-trigger active' : 'ghost-button assistant-menu-trigger'}
                type="button"
                onClick={() => setAiActionGroup((current) => (current === 'results' ? null : 'results'))}
              >
                查看结果
              </button>
            </div>

            {aiActionGroup === 'generate' ? (
              <div className="assistant-action-panel wrap">
                {(['summary', 'key-points', 'outline', 'review-questions', 'action-items'] as AiAnalysisType[]).map((type) => (
                  <button key={type} className="ghost-button" type="button" onClick={() => onCreateAiAnalysis(type)} disabled={!notebook}>
                    生成{getAnalysisTypeLabel(type)}
                  </button>
                ))}
              </div>
            ) : null}

            {aiActionGroup === 'results' ? (
              <div className="assistant-action-panel compact assistant-results-summary">
                <span className="note-strip-stats-chip">{scopedJobs.length} 条分析任务</span>
                <span className="note-strip-stats-chip">{scopedResults.length} 个结果块</span>
              </div>
            ) : null}
          </div>

          <div className="assistant-ai-results">
            {scopedJobs.length > 0 ? (
              scopedJobs.map((job) => {
                const resultBlocks = scopedResults.filter((result) => result.jobId === job.id);

                return (
                  <article key={job.id} className="assistant-result-card">
                    <div className="assistant-result-header">
                      <div>
                        <strong>{getAnalysisTypeLabel(job.analysisType)}</strong>
                        <div className="assistant-result-meta">
                          <span className={job.status === 'failed' ? 'assistant-result-status failed' : 'assistant-result-status'}>
                            {getAnalysisJobStatusLabel(job.status)}
                          </span>
                          <span>{formatTime(job.updatedAt)}</span>
                        </div>
                      </div>
                      <div className="assistant-result-actions">
                        <button className="ghost-button assistant-result-action" type="button" onClick={() => onDeleteAiAnalysis(job)}>
                          删除结果
                        </button>
                        <button
                          className="ghost-button assistant-result-action"
                          type="button"
                          onClick={() => onSaveAiAnalysisAsNote(job)}
                          disabled={job.status !== 'completed' || resultBlocks.length === 0}
                        >
                          保存为新笔记
                        </button>
                      </div>
                    </div>
                    {job.errorMessage ? <div className="assistant-runtime-error">{job.errorMessage}</div> : null}
                    {job.status === 'running' && resultBlocks.length === 0 ? (
                      <div className="assistant-empty-state">AI 正在生成内容，请稍等片刻。</div>
                    ) : null}
                    {resultBlocks.map((result) => (
                      <div key={result.id} className="assistant-result-block">
                        <div className="assistant-result-title">{result.title}</div>
                        <pre className="assistant-result-markdown">{result.contentMarkdown}</pre>
                      </div>
                    ))}
                  </article>
                );
              })
            ) : (
              <div className="assistant-empty-state">还没有 AI 分析结果。先选择一条笔记或启动一次转写，再点击上方功能入口生成结果。</div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

type EditorPanelProps = {
  note: NoteRecord | null;
  draftTitle: string;
  draftHtml: string;
  dirty: boolean;
  collapsed: boolean;
  exportingPdf: boolean;
  onTitleChange: (value: string) => void;
  onHtmlChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onExportPdf: () => void;
  onToggleCollapse: () => void;
  onResetLayout: () => void;
};

function EditorPanel({
  note,
  draftTitle,
  draftHtml,
  dirty,
  collapsed,
  exportingPdf,
  onTitleChange,
  onHtmlChange,
  onSave,
  onDelete,
  onExportPdf,
  onToggleCollapse,
  onResetLayout
}: EditorPanelProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit,
      TextStyle,
      Color,
      Highlight,
      FontSize,
      Image.configure({
        inline: false,
        allowBase64: true
      }),
      Placeholder.configure({
        placeholder: '记录课堂笔记、关键截图和重点总结...'
      }),
      Table.configure({
        resizable: true
      }),
      TableRow,
      TableHeader,
      TableCell
    ],
    content: draftHtml,
    editorProps: {
      attributes: {
        class: 'tiptap'
      }
    },
    onUpdate: ({ editor: currentEditor }) => {
      onHtmlChange(currentEditor.getHTML());
    }
  });

  useEffect(() => {
    if (!editor) {
      return;
    }

    const currentHtml = normalizeRichTextHtml(editor.getHTML());
    const nextHtml = normalizeRichTextHtml(ensureEditableRichTextHtml(draftHtml));

    if (currentHtml !== nextHtml) {
      editor.commands.setContent(nextHtml, false);
    }
  }, [draftHtml, editor]);

  const currentFontSize = (editor?.getAttributes('textStyle').fontSize as string | undefined) ?? DEFAULT_FONT_SIZE;
  const currentColor = (editor?.getAttributes('textStyle').color as string | undefined) ?? DEFAULT_TEXT_COLOR;
  const canUndo = editor?.can().chain().focus().undo().run() ?? false;
  const canRedo = editor?.can().chain().focus().redo().run() ?? false;

  function setFontSize(value: string) {
    editor?.chain().focus().setMark('textStyle', { fontSize: value }).run();
  }

  function applyTextColor(color: string) {
    editor?.chain().focus().setColor(color).run();
  }

  async function handleInsertImage(file: File | null) {
    if (!file || !editor) {
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      const fileUrl = (await window.noteApp.saveImage(dataUrl, file.name)) as string;
      editor
        .chain()
        .focus()
        .insertContent([
          {
            type: 'image',
            attrs: {
              src: fileUrl,
              alt: file.name
            }
          },
          {
            type: 'paragraph'
          }
        ])
        .run();
    } catch (error) {
      const message = error instanceof Error ? error.message : '插入图片失败。';
      window.alert(message);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  if (!note) {
    return <div className="editor-empty-state">先在上方笔记片段区选择一条笔记，或新建一条课堂笔记。</div>;
  }

  return (
    <section className={collapsed ? 'editor-panel collapsed' : 'editor-panel'}>
      <header className="editor-header">
        <div>
          <div className="editor-meta">课堂笔记编辑区</div>
          <input
            className="note-title-input"
            value={draftTitle}
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="输入笔记标题"
          />
        </div>
        <div className="editor-actions">
          <button className="ghost-button" onClick={onExportPdf} type="button" disabled={exportingPdf}>
            {exportingPdf ? '导出中...' : '导出 PDF'}
          </button>
          <button className="ghost-button" onClick={() => fileInputRef.current?.click()} type="button">
            插入图片
          </button>
          <button className="ghost-button" onClick={onResetLayout} type="button">
            恢复布局
          </button>
          <button className="ghost-button" onClick={onToggleCollapse} type="button">
            {collapsed ? '展开编辑区' : '折叠编辑区'}
          </button>
          <button className="ghost-button danger-button" onClick={onDelete} type="button">
            删除笔记
          </button>
          <button className="primary-button" onClick={onSave} type="button" disabled={!dirty}>
            {dirty ? '保存修改' : '已保存'}
          </button>
        </div>
      </header>

      {collapsed ? (
        <div className="collapsed-hint">编辑区已折叠，点击右上角“展开编辑区”继续编辑。</div>
      ) : (
        <>
          <div className="editor-toolbar">
            <button
              className={editor?.isActive('bold') ? 'toolbar-button active' : 'toolbar-button'}
              type="button"
              onClick={() => editor?.chain().focus().toggleBold().run()}
            >
              加粗
            </button>
            <button
              className={editor?.isActive('italic') ? 'toolbar-button active' : 'toolbar-button'}
              type="button"
              onClick={() => editor?.chain().focus().toggleItalic().run()}
            >
              斜体
            </button>
            <button
              className={editor?.isActive('highlight') ? 'toolbar-button active' : 'toolbar-button'}
              type="button"
              onClick={() => editor?.chain().focus().toggleHighlight({ color: '#fff2a8' }).run()}
            >
              高亮
            </button>
            <button
              className={editor?.isActive('bulletList') ? 'toolbar-button active' : 'toolbar-button'}
              type="button"
              onClick={() => editor?.chain().focus().toggleBulletList().run()}
            >
              列表
            </button>
            <button
              className={editor?.isActive('heading', { level: 2 }) ? 'toolbar-button active' : 'toolbar-button'}
              type="button"
              onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
            >
              标题
            </button>
            <button
              className={editor?.isActive('codeBlock') ? 'toolbar-button active' : 'toolbar-button'}
              type="button"
              onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
            >
              代码块
            </button>
            <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().setHorizontalRule().run()}>
              分隔线
            </button>
            <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().undo().run()} disabled={!canUndo}>
              撤回
            </button>
            <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().redo().run()} disabled={!canRedo}>
              重做
            </button>

            <label className="toolbar-select-wrap">
              <span>字号</span>
              <select value={currentFontSize} onChange={(event) => setFontSize(event.target.value)}>
                {FONT_SIZE_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>

            <div className="color-tools">
              {COLOR_SWATCHES.map((color) => (
                <button
                  key={color}
                  className={currentColor.toLowerCase() === color.toLowerCase() ? 'color-swatch active' : 'color-swatch'}
                  type="button"
                  style={{ backgroundColor: color }}
                  title={`设置为 ${color}`}
                  onClick={() => applyTextColor(color)}
                />
              ))}
              <label className="color-picker-label" title="选择更多文字颜色">
                <input
                  className="color-picker-input"
                  type="color"
                  value={currentColor}
                  onChange={(event) => applyTextColor(event.target.value)}
                />
                自定义颜色
              </label>
              <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().unsetColor().run()}>
                清除颜色
              </button>
            </div>

            <div className="table-tools">
              <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
                插入表格
              </button>
              <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().addRowAfter().run()} disabled={!editor?.isActive('table')}>
                加行
              </button>
              <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().addColumnAfter().run()} disabled={!editor?.isActive('table')}>
                加列
              </button>
              <button className="toolbar-button" type="button" onClick={() => editor?.chain().focus().deleteTable().run()} disabled={!editor?.isActive('table')}>
                删除表格
              </button>
            </div>
          </div>

          <div className="editor-surface">
            <EditorContent editor={editor} />
          </div>
        </>
      )}

      <input
        ref={fileInputRef}
        hidden
        type="file"
        accept="image/*"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          void handleInsertImage(file);
          event.target.value = '';
        }}
      />
    </section>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    notebooks: [],
    notes: [],
    transcriptSessions: [],
    transcriptSegments: [],
    aiAnalysisJobs: [],
    aiAnalysisResults: []
  });
  const [selectedNotebookId, setSelectedNotebookId] = useState('');
  const [selectedNoteId, setSelectedNoteId] = useState('');
  const [draftTitle, setDraftTitle] = useState('');
  const [draftHtml, setDraftHtml] = useState('<p></p>');
  const [dirty, setDirty] = useState(false);
  const [notebookQuery, setNotebookQuery] = useState('');
  const [noteQuery, setNoteQuery] = useState('');
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>(createSettingsDraft(DEFAULT_APP_SETTINGS));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState<{ sessionId: string | null; text: string }>({
    sessionId: null,
    text: ''
  });
  const [diagnosticLogs, setDiagnosticLogs] = useState<DiagnosticLogEntry[]>([]);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [runtimeState, setRuntimeState] = useState<TranscriptionRuntimeState>({
    sessionId: null,
    phase: 'idle',
    chunkCount: 0,
    sampleRate: null,
    channelCount: null,
    lastPeak: null,
    lastError: null,
    updatedAt: null
  });
  const previousRuntimeStateRef = useRef<TranscriptionRuntimeState | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(getStoredNumber(SIDEBAR_WIDTH_KEY, DEFAULT_SIDEBAR_WIDTH), MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  );
  const [noteStripHeight, setNoteStripHeight] = useState(() =>
    clamp(getStoredNumber(NOTE_STRIP_HEIGHT_KEY, DEFAULT_NOTE_STRIP_HEIGHT), MIN_NOTE_STRIP_HEIGHT, MAX_NOTE_STRIP_HEIGHT)
  );
  const [noteStripCollapsed, setNoteStripCollapsed] = useState(() => getStoredBoolean(NOTE_STRIP_COLLAPSED_KEY));
  const [editorCollapsed, setEditorCollapsed] = useState(() => getStoredBoolean(EDITOR_COLLAPSED_KEY));
  const [notebookDialog, setNotebookDialog] = useState<NotebookDialogState>({
    open: false,
    mode: 'create',
    notebookId: '',
    name: ''
  });
  const [notebookDialogSaving, setNotebookDialogSaving] = useState(false);
  const [aiNoteSaveDialog, setAiNoteSaveDialog] = useState<AiNoteSaveDialogState>({
    open: false,
    jobId: '',
    notebookId: '',
    title: ''
  });
  const [aiNoteSaveDialogSaving, setAiNoteSaveDialogSaving] = useState(false);
  const [exportingPdf, setExportingPdf] = useState(false);
  const [noteStripActionGroup, setNoteStripActionGroup] = useState<'notes' | 'assistant' | 'layout' | null>('notes');
  const [windowWidth, setWindowWidth] = useState(() => (typeof window === 'undefined' ? 1440 : window.innerWidth));
  const shellRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const dragStateRef = useRef<
    | {
        type: 'sidebar' | 'note-strip';
        startPointer: number;
        startSize: number;
      }
    | null
  >(null);

  const isCompactLayout = windowWidth <= 1100;

  useEffect(() => {
    const handleWindowResize = () => setWindowWidth(window.innerWidth);

    window.addEventListener('resize', handleWindowResize);
    return () => window.removeEventListener('resize', handleWindowResize);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(NOTE_STRIP_HEIGHT_KEY, String(noteStripHeight));
  }, [noteStripHeight]);

  useEffect(() => {
    window.localStorage.setItem(NOTE_STRIP_COLLAPSED_KEY, String(noteStripCollapsed));
  }, [noteStripCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(EDITOR_COLLAPSED_KEY, String(editorCollapsed));
  }, [editorCollapsed]);

  useEffect(() => {
    if (isCompactLayout || noteStripCollapsed || noteStripActionGroup !== 'assistant') {
      return;
    }

    setNoteStripHeight((current) => Math.max(current, ASSISTANT_EXPANDED_HEIGHT));
  }, [isCompactLayout, noteStripActionGroup, noteStripCollapsed]);

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      const dragState = dragStateRef.current;

      if (!dragState) {
        return;
      }

      if (dragState.type === 'sidebar') {
        const shellBounds = shellRef.current?.getBoundingClientRect();
        const maxWidth = shellBounds ? Math.max(MIN_SIDEBAR_WIDTH, shellBounds.width - 540) : MAX_SIDEBAR_WIDTH;
        const nextWidth = clamp(
          dragState.startSize + (event.clientX - dragState.startPointer),
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, maxWidth)
        );

        setSidebarWidth(nextWidth);
        return;
      }

      const workspaceBounds = workspaceRef.current?.getBoundingClientRect();
      const maxHeight = workspaceBounds ? Math.max(MIN_NOTE_STRIP_HEIGHT, workspaceBounds.height - 220) : MAX_NOTE_STRIP_HEIGHT;
      const nextHeight = clamp(
        dragState.startSize + (event.clientY - dragState.startPointer),
        MIN_NOTE_STRIP_HEIGHT,
        Math.min(MAX_NOTE_STRIP_HEIGHT, maxHeight)
      );

      setNoteStripHeight(nextHeight);
    }

    function handlePointerUp() {
      if (!dragStateRef.current) {
        return;
      }

      dragStateRef.current = null;
      document.body.classList.remove('is-resizing', 'is-resizing-row');
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
    };
  }, []);

  function startResize(type: 'sidebar' | 'note-strip', event: ReactPointerEvent<HTMLDivElement>) {
    if (type === 'note-strip' && (noteStripCollapsed || editorCollapsed)) {
      return;
    }

    dragStateRef.current = {
      type,
      startPointer: type === 'sidebar' ? event.clientX : event.clientY,
      startSize: type === 'sidebar' ? sidebarWidth : noteStripHeight
    };

    document.body.classList.add(type === 'sidebar' ? 'is-resizing' : 'is-resizing-row');
  }

  function resetLayout() {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    setNoteStripHeight(DEFAULT_NOTE_STRIP_HEIGHT);
    setNoteStripCollapsed(false);
    setEditorCollapsed(false);
  }

  function toggleNoteStripCollapse() {
    setNoteStripCollapsed((value) => {
      const next = !value;

      if (next) {
        setEditorCollapsed(false);
      }

      return next;
    });
  }

  function toggleEditorCollapse() {
    setEditorCollapsed((value) => {
      const next = !value;

      if (next) {
        setNoteStripCollapsed(false);
      }

      return next;
    });
  }

  function openSettings() {
    setSettingsDraft(createSettingsDraft(settings));
    setSettingsOpen(true);
  }

  function pushDiagnosticLog(level: DiagnosticLogEntry['level'], message: string) {
    if (level !== 'error') {
      return;
    }

    const entry: DiagnosticLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      level,
      message,
      timestamp: new Date().toISOString()
    };

    setDiagnosticLogs((current) => [entry, ...current].slice(0, 80));
  }

  async function loadSnapshot() {
    const next = (await window.noteApp.getSnapshot()) as Snapshot;
    setSnapshot(next);

    const firstNotebook = next.notebooks[0]?.id ?? '';
    const targetNotebookId = next.notebooks.some((item) => item.id === selectedNotebookId)
      ? selectedNotebookId
      : firstNotebook;
    const notesInTarget = next.notes.filter((item) => item.notebookId === targetNotebookId);
    const firstNote = notesInTarget[0]?.id ?? '';
    const targetNoteId = notesInTarget.some((item) => item.id === selectedNoteId)
      ? selectedNoteId
      : firstNote;

    setSelectedNotebookId(targetNotebookId);
    setSelectedNoteId(targetNoteId);
  }

  async function loadSettings() {
    const next = normalizeAppSettings((await window.noteApp.getSettings()) as AppSettings);
    setSettings(next);
    setSettingsDraft(createSettingsDraft(next));
  }

  async function loadRuntimeState() {
    const next = (await window.noteApp.getTranscriptionRuntimeState()) as TranscriptionRuntimeState;
    const previous = previousRuntimeStateRef.current;

    if (!previous) {
      pushDiagnosticLog('info', `运行态已加载，当前采集阶段 ${next.phase}，ASR ${next.asrConnectionState ?? 'idle'}。`);
    } else {
      if (previous.phase !== next.phase) {
        pushDiagnosticLog('info', `采集阶段从 ${previous.phase} 变为 ${next.phase}。`);
      }

      if (previous.asrConnectionState !== next.asrConnectionState && next.asrConnectionState) {
        pushDiagnosticLog('info', `ASR 连接状态变为 ${next.asrConnectionState}。`);
      }

      if (previous.lastError !== next.lastError && next.lastError) {
        pushDiagnosticLog('error', `采集错误：${next.lastError}`);
      }

      if (previous.asrLastError !== next.asrLastError && next.asrLastError) {
        pushDiagnosticLog('error', `ASR 错误：${next.asrLastError}`);
      }

      if (previous.asrLastEventType !== next.asrLastEventType && next.asrLastEventType) {
        pushDiagnosticLog('info', `收到 ASR 事件：${next.asrLastEventType}`);
      }

      if (next.chunkCount > 0 && next.chunkCount !== previous.chunkCount && next.chunkCount % 25 === 0) {
        pushDiagnosticLog('success', `系统音频已采集 ${next.chunkCount} 个音频块，最近峰值 ${next.lastPeak?.toFixed(3) ?? '--'}。`);
      }

      if (
        (next.asrReceivedMessageCount ?? 0) > 0 &&
        (next.asrReceivedMessageCount ?? 0) !== (previous.asrReceivedMessageCount ?? 0) &&
        (next.asrReceivedMessageCount ?? 0) % 5 === 0
      ) {
        pushDiagnosticLog('success', `ASR 已收到 ${next.asrReceivedMessageCount ?? 0} 条服务端消息。`);
      }
    }

    previousRuntimeStateRef.current = next;
    setRuntimeState(next);
  }

  useEffect(() => {
    void loadSnapshot();
    void loadSettings();
    void loadRuntimeState();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadRuntimeState();
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const disposeSegment = window.noteApp.onTranscriptionSegment((payload: {
      sessionId: string;
      noteId: string | null;
      sequenceNo: number;
      text: string;
      isFinal: boolean;
    }) => {
      if (!payload.isFinal) {
        setLiveTranscript({
          sessionId: payload.sessionId,
          text: payload.text
        });

        if (payload.noteId && payload.noteId === selectedNoteId) {
          setDraftHtml((current) => upsertLiveTranscriptParagraph(current, payload.text));
        }

        pushDiagnosticLog('info', `收到实时转写片段：${payload.text.slice(0, 60) || '空文本'}`);
        return;
      }

      setLiveTranscript((current) =>
        current.sessionId === payload.sessionId
          ? {
              sessionId: payload.sessionId,
              text: ''
            }
          : current
      );

      if (payload.noteId && payload.noteId === selectedNoteId) {
        setDraftHtml((current) => appendTranscriptParagraph(current, payload.text));
      }

      pushDiagnosticLog('success', `收到最终转写片段：${payload.text.slice(0, 80) || '空文本'}`);

      void loadSnapshot();
      void loadRuntimeState();
    });

    const disposeError = window.noteApp.onTranscriptionError((payload: { sessionId: string; message: string }) => {
      setLiveTranscript((current) =>
        current.sessionId === payload.sessionId
          ? {
              sessionId: payload.sessionId,
              text: ''
            }
          : current
      );
      setDraftHtml((current) => removeLiveTranscriptParagraph(current));
      pushDiagnosticLog('error', `转写错误：${payload.message}`);
      void loadRuntimeState();
    });

    return () => {
      disposeSegment();
      disposeError();
    };
  }, [selectedNotebookId, selectedNoteId]);

  const filteredNotebooks = useMemo(() => {
    const keyword = notebookQuery.trim().toLowerCase();

    if (!keyword) {
      return snapshot.notebooks;
    }

    return snapshot.notebooks.filter((notebook) => notebook.name.toLowerCase().includes(keyword));
  }, [notebookQuery, snapshot.notebooks]);

  const selectedNotebook = snapshot.notebooks.find((notebook) => notebook.id === selectedNotebookId) ?? null;

  const notebookNotes = useMemo(() => {
    const keyword = noteQuery.trim().toLowerCase();

    return snapshot.notes.filter((note) => {
      if (note.notebookId !== selectedNotebookId) {
        return false;
      }

      if (!keyword) {
        return true;
      }

      return `${note.title} ${stripHtml(note.contentHtml)}`.toLowerCase().includes(keyword);
    });
  }, [noteQuery, selectedNotebookId, snapshot.notes]);

  const selectedNote = snapshot.notes.find((note) => note.id === selectedNoteId) ?? null;
  const normalizedDraftHtml = normalizeRichTextHtml(removeLiveTranscriptParagraph(draftHtml));
  const normalizedSelectedHtml = normalizeRichTextHtml(removeLiveTranscriptParagraph(selectedNote?.contentHtml || '<p></p>'));
  const hasUnsavedChanges = Boolean(
    selectedNote && (draftTitle !== selectedNote.title || normalizedDraftHtml !== normalizedSelectedHtml)
  );

  function selectNotebook(notebookId: string) {
    setSelectedNotebookId(notebookId);

    const firstNoteId = snapshot.notes.find((note) => note.notebookId === notebookId)?.id ?? '';
    setSelectedNoteId(firstNoteId);
  }

  useEffect(() => {
    if (!selectedNote) {
      setDraftTitle('');
      setDraftHtml('<p></p>');
      return;
    }

    setDraftTitle(selectedNote.title);
    setDraftHtml(ensureEditableRichTextHtml(selectedNote.contentHtml || '<p></p>'));
  }, [selectedNote?.id]);

  useEffect(() => {
    setDirty(hasUnsavedChanges);
  }, [hasUnsavedChanges]);

  function confirmDiscardIfNeeded(action: () => void) {
    if (!dirty) {
      action();
      return;
    }

    if (window.confirm('当前笔记有未保存修改，确认放弃这些修改吗？')) {
      action();
    }
  }

  async function refreshAfterMutation(
    nextSnapshot: Snapshot,
    preferredSelection?: { notebookId?: string; noteId?: string }
  ) {
    setSnapshot(nextSnapshot);

    const preferredNotebookId = preferredSelection?.notebookId;
    const notebookStillExists = nextSnapshot.notebooks.some((item) => item.id === selectedNotebookId);
    const preferredNotebookExists = preferredNotebookId
      ? nextSnapshot.notebooks.some((item) => item.id === preferredNotebookId)
      : false;
    const nextNotebookId = preferredNotebookExists
      ? preferredNotebookId ?? ''
      : notebookStillExists
        ? selectedNotebookId
        : nextSnapshot.notebooks[0]?.id ?? '';

    const notesInNotebook = nextSnapshot.notes.filter((item) => item.notebookId === nextNotebookId);
    const preferredNoteId = preferredSelection?.noteId;
    const noteStillExists = notesInNotebook.some((item) => item.id === selectedNoteId);
    const preferredNoteExists = preferredNoteId ? notesInNotebook.some((item) => item.id === preferredNoteId) : false;
    const nextNoteId = preferredNoteExists
      ? preferredNoteId ?? ''
      : noteStillExists
        ? selectedNoteId
        : notesInNotebook[0]?.id ?? '';

    setSelectedNotebookId(nextNotebookId);
    setSelectedNoteId(nextNoteId);
  }

  function handleCreateNotebook() {
    setNotebookDialog({
      open: true,
      mode: 'create',
      notebookId: '',
      name: ''
    });
  }

  function handleRenameNotebook(notebook: NotebookSummary) {
    setNotebookDialog({
      open: true,
      mode: 'rename',
      notebookId: notebook.id,
      name: notebook.name
    });
  }

  async function handleSubmitNotebookDialog() {
    const name = notebookDialog.name.trim();

    if (!name || notebookDialogSaving) {
      return;
    }

    setNotebookDialogSaving(true);

    try {
      const next =
        notebookDialog.mode === 'create'
          ? ((await window.noteApp.createNotebook(name)) as Snapshot)
          : ((await window.noteApp.renameNotebook(notebookDialog.notebookId, name)) as Snapshot);

      await refreshAfterMutation(next);
      setNotebookDialog({
        open: false,
        mode: 'create',
        notebookId: '',
        name: ''
      });
    } finally {
      setNotebookDialogSaving(false);
    }
  }

  async function handleDeleteNotebook(notebook: NotebookSummary) {
    if (!window.confirm(`确认删除课程“${notebook.name}”及其所有笔记吗？`)) {
      return;
    }

    const next = (await window.noteApp.deleteNotebook(notebook.id)) as Snapshot;
    await refreshAfterMutation(next);
  }

  async function handleCreateNote() {
    if (!selectedNotebookId) {
      return;
    }

    const next = (await window.noteApp.createNote(selectedNotebookId)) as Snapshot;
    await refreshAfterMutation(next);
  }

  async function handleSaveNote() {
    if (!selectedNote) {
      return;
    }

    try {
      const normalizedHtml = ensureEditableRichTextHtml(removeLiveTranscriptParagraph(draftHtml));
      const next = (await window.noteApp.updateNote(selectedNote.id, draftTitle, normalizedHtml)) as Snapshot;
      setDraftHtml(normalizedHtml);
      await refreshAfterMutation(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存笔记失败。';
      pushDiagnosticLog('error', `保存笔记失败：${message}`);
      window.alert(message);
    }
  }

  async function handleDeleteNote() {
    if (!selectedNote) {
      return;
    }

    if (!window.confirm(`确认删除笔记“${selectedNote.title}”吗？`)) {
      return;
    }

    const next = (await window.noteApp.deleteNote(selectedNote.id)) as Snapshot;
    await refreshAfterMutation(next);
  }

  async function handleStartTranscription() {
    if (!selectedNotebookId) {
      return;
    }

    const title = `${selectedNotebook?.name ?? '课程'} ${dayjs().format('HH:mm')} 课堂实录`;
    pushDiagnosticLog('info', `开始转写，请求已发出。课程：${selectedNotebook?.name ?? '未命名课程'}。`);
    const next = (await window.noteApp.startTranscription({
      notebookId: selectedNotebookId,
      noteId: selectedNoteId || null,
      title,
      language: 'zh-CN'
    })) as Snapshot;

    await refreshAfterMutation(next);
  }

  async function handlePauseTranscription(sessionId: string) {
    pushDiagnosticLog('warning', `暂停转写：${sessionId}`);
    const next = (await window.noteApp.pauseTranscription(sessionId)) as Snapshot;
    await refreshAfterMutation(next);
  }

  async function handleResumeTranscription(sessionId: string) {
    pushDiagnosticLog('info', `继续转写：${sessionId}`);
    const next = (await window.noteApp.resumeTranscription(sessionId)) as Snapshot;
    await refreshAfterMutation(next);
  }

  async function handleStopTranscription(sessionId: string) {
    pushDiagnosticLog('warning', `停止转写：${sessionId}`);
    const next = (await window.noteApp.stopTranscription(sessionId)) as Snapshot;
    setLiveTranscript({ sessionId: null, text: '' });
    setDraftHtml((current) => removeLiveTranscriptParagraph(current));
    await refreshAfterMutation(next);
  }

  async function handleCreateAiAnalysis(analysisType: AiAnalysisType) {
    if (!selectedNotebookId) {
      return;
    }

    const currentSession = snapshot.transcriptSessions.find(
      (session) =>
        session.notebookId === selectedNotebookId &&
        (session.status === 'recording' || session.status === 'paused')
    ) ?? snapshot.transcriptSessions.find((session) => session.notebookId === selectedNotebookId) ?? null;

    const next = (await window.noteApp.createAiAnalysis({
      notebookId: selectedNotebookId,
      noteId: selectedNoteId || null,
      sessionId: currentSession?.id ?? null,
      analysisType
    })) as Snapshot;

    await refreshAfterMutation(next);
  }

  function getDefaultAiNoteTitle(job: AiAnalysisJobRecord) {
    const linkedNote = job.noteId ? snapshot.notes.find((item) => item.id === job.noteId) : null;
    const linkedNotebook = snapshot.notebooks.find((item) => item.id === job.notebookId);
    const sourceTitle = linkedNote?.title || linkedNotebook?.name || '课堂笔记分析';
    return `${sourceTitle} - AI${getAnalysisTypeLabel(job.analysisType)}`;
  }

  async function handleDeleteAiAnalysis(job: AiAnalysisJobRecord) {
    if (!window.confirm(`确认删除这条${getAnalysisTypeLabel(job.analysisType)}结果吗？删除后无法恢复。`)) {
      return;
    }

    try {
      const next = (await window.noteApp.deleteAiAnalysis(job.id)) as Snapshot;
      await refreshAfterMutation(next);
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除 AI 分析结果失败。';
      pushDiagnosticLog('error', message);
      window.alert(message);
    }
  }

  function handleSaveAiAnalysisAsNote(job: AiAnalysisJobRecord) {
    setAiNoteSaveDialog({
      open: true,
      jobId: job.id,
      notebookId: job.notebookId,
      title: getDefaultAiNoteTitle(job)
    });
  }

  async function handleSubmitAiNoteSaveDialog() {
    if (!aiNoteSaveDialog.open || aiNoteSaveDialogSaving || !aiNoteSaveDialog.title.trim()) {
      return;
    }

    setAiNoteSaveDialogSaving(true);

    try {
      const result = (await window.noteApp.saveAiAnalysisAsNote(
        aiNoteSaveDialog.jobId,
        aiNoteSaveDialog.title.trim()
      )) as SaveAiAnalysisAsNoteResult;
      const targetNotebookId = aiNoteSaveDialog.notebookId;

      setAiNoteSaveDialog({
        open: false,
        jobId: '',
        notebookId: '',
        title: ''
      });

      if (dirty) {
        const shouldSwitch = window.confirm('AI 分析内容已保存为新笔记。当前笔记仍有未保存修改，是否立即切换到新笔记？');

        if (shouldSwitch) {
          await refreshAfterMutation(result.snapshot, {
            notebookId: targetNotebookId,
            noteId: result.noteId
          });
          return;
        }

        await refreshAfterMutation(result.snapshot);
        return;
      }

      await refreshAfterMutation(result.snapshot, {
        notebookId: targetNotebookId,
        noteId: result.noteId
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存 AI 分析结果失败。';
      pushDiagnosticLog('error', message);
      window.alert(message);
    } finally {
      setAiNoteSaveDialogSaving(false);
    }
  }

  async function handleExportPdf() {
    if (!selectedNote) {
      return;
    }

    setExportingPdf(true);

    try {
      const result = (await window.noteApp.exportNotePdf(
        draftTitle.trim() || selectedNote.title,
        removeLiveTranscriptParagraph(draftHtml)
      )) as ExportPdfResult;

      if (!result.canceled && result.filePath) {
        window.alert(`PDF 已导出到：${result.filePath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出 PDF 失败。';
      pushDiagnosticLog('error', message);
      window.alert(message);
    } finally {
      setExportingPdf(false);
    }
  }

  async function handleSaveSettings() {
    setSettingsSaving(true);

    try {
      const payload: SaveAppSettingsPayload = {
        asrProvider: settingsDraft.asrProvider,
        asrModel: settingsDraft.asrModel,
        llmProvider: settingsDraft.llmProvider,
        llmModel: settingsDraft.llmModel,
        asrApiKeyInput: settingsDraft.asrApiKeyInput.trim() || undefined,
        llmApiKeyInput: settingsDraft.llmApiKeyInput.trim() || undefined,
        clearAsrApiKey: settingsDraft.clearAsrApiKey,
        clearLlmApiKey: settingsDraft.clearLlmApiKey
      };

      const next = normalizeAppSettings(
        (await window.noteApp.saveSettings(payload)) as AppSettings
      );

      setSettings(next);
      setSettingsDraft(createSettingsDraft(next));
      setSettingsOpen(false);
    } finally {
      setSettingsSaving(false);
    }
  }

  const workspaceRows = isCompactLayout
    ? undefined
    : noteStripCollapsed
      ? `${COLLAPSED_SECTION_HEIGHT}px 12px minmax(0, 1fr)`
      : editorCollapsed
        ? `minmax(${MIN_NOTE_STRIP_HEIGHT}px, 1fr) 12px ${COLLAPSED_SECTION_HEIGHT}px`
        : `${noteStripHeight}px 12px minmax(0, 1fr)`;

  return (
    <div
      className={isCompactLayout ? 'shell compact' : 'shell'}
      ref={shellRef}
      style={isCompactLayout ? undefined : { gridTemplateColumns: `${sidebarWidth}px 12px minmax(0, 1fr)` }}
    >
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="brand-block">
            <img className="brand-icon" src={appIcon} alt="AICourseNote" />
            <div className="brand-copy">
              <div className="section-caption">课程笔记本</div>
              <h1>AICourseNote</h1>
            </div>
          </div>
          <div className="sidebar-header-actions">
            <button className="ghost-button settings-icon-button" type="button" onClick={openSettings}>
              设置
            </button>
          </div>
        </header>

        <div className="sidebar-summary-bar">
          <span>{snapshot.notebooks.length} 门课程</span>
          <span className="sidebar-summary-divider" />
          <span>{snapshot.notes.length} 条笔记</span>
          <span className="sidebar-summary-divider" />
          <span>ASR {settings.asrApiKeyConfigured ? '已配置' : '未配置'}</span>
          <span className="sidebar-summary-divider" />
          <span>LLM {settings.llmApiKeyConfigured ? '已配置' : '未配置'}</span>
        </div>

        <div className="sidebar-controls">
          <button className="settings-entry-button" type="button" onClick={openSettings}>
            <div className="settings-entry-copy">
              <strong>API 与模型设置</strong>
              <span>在这里管理已保存的语音转写与大模型 API key</span>
            </div>
            <span className="settings-entry-status">
              {settings.asrApiKeyConfigured && settings.llmApiKeyConfigured ? '已配置' : '去配置'}
            </span>
          </button>
          <input
            className="search-input"
            placeholder="搜索课程"
            value={notebookQuery}
            onChange={(event) => setNotebookQuery(event.target.value)}
          />
          <button className="primary-button sidebar-create-button wide" type="button" onClick={handleCreateNotebook}>
            新建课程
          </button>
        </div>

        <div className="sidebar-list">
          {filteredNotebooks.map((notebook) => {
            const accentColor = getAccentColor(notebook.id);

            return (
              <article
                key={notebook.id}
                className={notebook.id === selectedNotebookId ? 'sidebar-item-shell active' : 'sidebar-item-shell'}
                title={notebook.name}
              >
                <button
                  type="button"
                  className="sidebar-item"
                  onClick={() => confirmDiscardIfNeeded(() => selectNotebook(notebook.id))}
                >
                  <div className="sidebar-item-badge" style={{ backgroundColor: accentColor }}>
                    {getShortName(notebook.name)}
                  </div>
                  <div className="sidebar-item-main">
                    <div className="sidebar-item-title-row">
                      <div className="sidebar-item-title">{notebook.name}</div>
                      <span className="sidebar-item-timestamp">{formatTime(notebook.updatedAt)}</span>
                    </div>
                    <div className="sidebar-item-meta-row">
                      <div className="sidebar-item-meta">{notebook.noteCount} 条笔记</div>
                    </div>
                  </div>
                </button>
                <div className="sidebar-item-actions">
                  <button className="link-action sidebar-action-button" type="button" onClick={() => handleRenameNotebook(notebook)}>
                    重命名
                  </button>
                  <button
                    className="link-action danger-link sidebar-action-button"
                    type="button"
                    onClick={() => void handleDeleteNotebook(notebook)}
                  >
                    删除
                  </button>
                </div>
              </article>
            );
          })}
        </div>

      </aside>

      {!isCompactLayout ? (
        <div
          className="panel-resizer vertical"
          onPointerDown={(event) => startResize('sidebar', event)}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整课程列表宽度"
        />
      ) : null}

      <main className="workspace" ref={workspaceRef} style={workspaceRows ? { gridTemplateRows: workspaceRows } : undefined}>
        <section className={noteStripCollapsed ? 'note-strip collapsed' : 'note-strip'}>
          <header className="note-strip-header">
            <div>
              <div className="section-caption">笔记片段</div>
              <h2>{selectedNotebook?.name ?? '未选择课程'}</h2>
            </div>
            <div className="panel-header-actions">
              <span className="note-strip-stats-chip">{notebookNotes.length} 条笔记</span>
              {noteStripCollapsed ? (
                <button className="ghost-button" type="button" onClick={toggleNoteStripCollapse}>
                  展开片段区
                </button>
              ) : null}
            </div>
          </header>

          {noteStripCollapsed ? (
            <div className="collapsed-hint">
              当前课程共有 {notebookNotes.length} 条笔记片段，点击右上角“展开片段区”查看详情。
            </div>
          ) : (
            <>
              <div className="note-strip-toolbar">
                <div className="note-strip-menu-row">
                  <button
                    className={noteStripActionGroup === 'notes' ? 'ghost-button note-strip-menu-button active' : 'ghost-button note-strip-menu-button'}
                    type="button"
                    onClick={() => setNoteStripActionGroup((current) => (current === 'notes' ? null : 'notes'))}
                  >
                    笔记操作
                  </button>
                  <button
                    className={noteStripActionGroup === 'assistant' ? 'ghost-button note-strip-menu-button active' : 'ghost-button note-strip-menu-button'}
                    type="button"
                    onClick={() => setNoteStripActionGroup((current) => (current === 'assistant' ? null : 'assistant'))}
                  >
                    课堂助手
                  </button>
                  <button
                    className={noteStripActionGroup === 'layout' ? 'ghost-button note-strip-menu-button active' : 'ghost-button note-strip-menu-button'}
                    type="button"
                    onClick={() => setNoteStripActionGroup((current) => (current === 'layout' ? null : 'layout'))}
                  >
                    布局工具
                  </button>
                </div>

                {noteStripActionGroup === 'notes' ? (
                  <div className="note-strip-action-panel">
                    <input
                      className="search-input"
                      placeholder="搜索当前课程中的笔记"
                      value={noteQuery}
                      onChange={(event) => setNoteQuery(event.target.value)}
                    />
                    <div className="note-strip-panel-actions">
                      <button className="primary-button" type="button" onClick={handleCreateNote} disabled={!selectedNotebookId}>
                        新建笔记
                      </button>
                      <div className="note-strip-stats-chip">{notebookNotes.length} 条匹配结果</div>
                    </div>
                  </div>
                ) : null}

                {noteStripActionGroup === 'assistant' ? (
                  <div className="note-strip-action-panel split">
                    <div className="note-strip-panel-copy">
                      <strong>课堂助手入口</strong>
                      <span>转写控制、AI 分析和运行状态已经收纳到下方面板中，需要时再展开使用。</span>
                    </div>
                    <div className="note-strip-panel-actions">
                      <button className="ghost-button" type="button" onClick={openSettings}>
                        打开 API 设置
                      </button>
                      <span className="note-strip-stats-chip">ASR {settings.asrApiKeyConfigured ? '已配置' : '未配置'}</span>
                      <span className="note-strip-stats-chip">LLM {settings.llmApiKeyConfigured ? '已配置' : '未配置'}</span>
                    </div>
                  </div>
                ) : null}

                {noteStripActionGroup === 'layout' ? (
                  <div className="note-strip-action-panel split">
                    <div className="note-strip-panel-copy">
                      <strong>布局操作</strong>
                      <span>用于恢复三栏布局或临时收起上方片段区。</span>
                    </div>
                    <div className="note-strip-panel-actions">
                      <button className="ghost-button" type="button" onClick={resetLayout}>
                        恢复布局
                      </button>
                      <button className="ghost-button" type="button" onClick={toggleNoteStripCollapse}>
                        折叠片段区
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              {noteStripActionGroup === 'assistant' ? (
                <AssistantPanel
                  notebook={selectedNotebook}
                  note={selectedNote}
                  runtimeState={runtimeState}
                  liveTranscriptText={selectedNotebook ? liveTranscript.text : ''}
                  settings={settings}
                  transcriptSessions={snapshot.transcriptSessions}
                  transcriptSegments={snapshot.transcriptSegments}
                  aiAnalysisJobs={snapshot.aiAnalysisJobs}
                  aiAnalysisResults={snapshot.aiAnalysisResults}
                  onOpenSettings={openSettings}
                  onStartTranscription={() => void handleStartTranscription()}
                  onPauseTranscription={(sessionId) => void handlePauseTranscription(sessionId)}
                  onResumeTranscription={(sessionId) => void handleResumeTranscription(sessionId)}
                  onStopTranscription={(sessionId) => void handleStopTranscription(sessionId)}
                  onCreateAiAnalysis={(analysisType) => void handleCreateAiAnalysis(analysisType)}
                  onDeleteAiAnalysis={(job) => void handleDeleteAiAnalysis(job)}
                  onSaveAiAnalysisAsNote={(job) => void handleSaveAiAnalysisAsNote(job)}
                />
              ) : null}

              {noteStripActionGroup !== 'assistant' ? (
                <div className="note-card-list">
                  {notebookNotes.length > 0 ? (
                    notebookNotes.map((note) => {
                      const accentColor = getAccentColor(note.id);

                      return (
                        <button
                          type="button"
                          key={note.id}
                          className={note.id === selectedNoteId ? 'note-card active' : 'note-card'}
                          onClick={() => confirmDiscardIfNeeded(() => setSelectedNoteId(note.id))}
                        >
                          <span className="note-card-accent" style={{ backgroundColor: accentColor }} />
                          <div className="note-card-header">
                            <strong>{note.title}</strong>
                            <span>{formatTime(note.updatedAt)}</span>
                          </div>
                          <div className="note-card-pill">课堂片段</div>
                          <p>{stripHtml(note.contentHtml) || '空白笔记'}</p>
                        </button>
                      );
                    })
                  ) : (
                    <div className="empty-inline-state">当前课程还没有匹配的笔记片段。</div>
                  )}
                </div>
              ) : null}
            </>
          )}
        </section>

        {!isCompactLayout ? (
          <div
            className={noteStripCollapsed || editorCollapsed ? 'panel-resizer horizontal disabled' : 'panel-resizer horizontal'}
            onPointerDown={(event) => startResize('note-strip', event)}
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整笔记片段区域高度"
          />
        ) : null}

        <EditorPanel
          note={selectedNote}
          draftTitle={draftTitle}
          draftHtml={draftHtml}
          dirty={hasUnsavedChanges}
          collapsed={editorCollapsed}
          exportingPdf={exportingPdf}
          onTitleChange={(value) => {
            setDraftTitle(value);
          }}
          onHtmlChange={(value) => {
            setDraftHtml(value);
          }}
          onSave={() => void handleSaveNote()}
          onDelete={() => void handleDeleteNote()}
          onExportPdf={() => void handleExportPdf()}
          onToggleCollapse={toggleEditorCollapse}
          onResetLayout={resetLayout}
        />
      </main>

      <SettingsModal
        open={settingsOpen}
        draft={settingsDraft}
        saving={settingsSaving}
        onClose={() => setSettingsOpen(false)}
        onFieldChange={(field, value) => {
          setSettingsDraft((current) => {
            if (field === 'asrProvider') {
              const normalized = normalizeProviderModelSelection(ASR_PROVIDER_PRESETS, value, '');

              return {
                ...current,
                asrProvider: normalized.provider,
                asrModel: normalized.model
              };
            }

            if (field === 'llmProvider') {
              const normalized = normalizeProviderModelSelection(LLM_PROVIDER_PRESETS, value, '');

              return {
                ...current,
                llmProvider: normalized.provider,
                llmModel: normalized.model
              };
            }

            if (field === 'asrApiKeyInput') {
              return {
                ...current,
                asrApiKeyInput: value,
                clearAsrApiKey: false
              };
            }

            if (field === 'llmApiKeyInput') {
              return {
                ...current,
                llmApiKeyInput: value,
                clearLlmApiKey: false
              };
            }

            return {
              ...current,
              [field]: value
            };
          });
        }}
        onToggleClear={(field) => {
          setSettingsDraft((current) => {
            if (field === 'clearAsrApiKey') {
              return {
                ...current,
                clearAsrApiKey: !current.clearAsrApiKey,
                asrApiKeyInput: ''
              };
            }

            return {
              ...current,
              clearLlmApiKey: !current.clearLlmApiKey,
              llmApiKeyInput: ''
            };
          });
        }}
        onSave={() => void handleSaveSettings()}
      />

      <NotebookModal
        state={notebookDialog}
        saving={notebookDialogSaving}
        onClose={() =>
          setNotebookDialog({
            open: false,
            mode: 'create',
            notebookId: '',
            name: ''
          })
        }
        onNameChange={(value) => setNotebookDialog((current) => ({ ...current, name: value }))}
        onSubmit={() => void handleSubmitNotebookDialog()}
      />

      <AiNoteSaveModal
        state={aiNoteSaveDialog}
        saving={aiNoteSaveDialogSaving}
        onClose={() =>
          setAiNoteSaveDialog({
            open: false,
            jobId: '',
            notebookId: '',
            title: ''
          })
        }
        onTitleChange={(value) => setAiNoteSaveDialog((current) => ({ ...current, title: value }))}
        onSubmit={() => void handleSubmitAiNoteSaveDialog()}
      />

      <ErrorLogLauncher count={diagnosticLogs.length} onOpen={() => setErrorLogOpen(true)} />
      <ErrorLogModal open={errorLogOpen} entries={diagnosticLogs} onClose={() => setErrorLogOpen(false)} onClear={() => setDiagnosticLogs([])} />
    </div>
  );
}
