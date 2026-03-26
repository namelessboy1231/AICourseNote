export type NotebookSummary = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  noteCount: number;
};

export type NoteRecord = {
  id: string;
  notebookId: string;
  title: string;
  contentHtml: string;
  createdAt: string;
  updatedAt: string;
};

export type TranscriptSessionStatus = 'idle' | 'recording' | 'paused' | 'stopped' | 'error';

export type TranscriptSessionRecord = {
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

export type TranscriptSegmentRecord = {
  id: string;
  sessionId: string;
  noteId: string | null;
  speakerLabel: string | null;
  text: string;
  normalizedText: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  isFinal: boolean;
  sequenceNo: number;
  confidence: number | null;
  rawPayload: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AiAnalysisType =
  | 'summary'
  | 'key-points'
  | 'outline'
  | 'review-questions'
  | 'action-items';

export type AiAnalysisJobRecord = {
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

export type AiAnalysisResultRecord = {
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

export type AppSettings = {
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

export type SaveAppSettingsPayload = {
  asrProvider: string;
  asrModel: string;
  llmProvider: string;
  llmModel: string;
  asrApiKeyInput?: string | null;
  llmApiKeyInput?: string | null;
  clearAsrApiKey?: boolean;
  clearLlmApiKey?: boolean;
};

export type TranscriptionRuntimeState = {
  sessionId: string | null;
  phase: 'idle' | 'starting' | 'recording' | 'paused' | 'stopped' | 'error';
  chunkCount: number;
  sampleRate: number | null;
  channelCount: number | null;
  lastPeak: number | null;
  lastError: string | null;
  asrProvider?: string | null;
  asrModel?: string | null;
  asrConnectionState?: 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'error';
  asrSentChunkCount?: number;
  asrReceivedMessageCount?: number;
  asrLastEventType?: string | null;
  asrLastError?: string | null;
  asrLastMessagePreview?: string | null;
  updatedAt: string | null;
};

export type Snapshot = {
  notebooks: NotebookSummary[];
  notes: NoteRecord[];
  transcriptSessions: TranscriptSessionRecord[];
  transcriptSegments: TranscriptSegmentRecord[];
  aiAnalysisJobs: AiAnalysisJobRecord[];
  aiAnalysisResults: AiAnalysisResultRecord[];
};

export type SaveAiAnalysisAsNoteResult = {
  snapshot: Snapshot;
  noteId: string;
};

export type ExportPdfResult = {
  canceled: boolean;
  filePath: string | null;
};