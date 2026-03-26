import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';

const root = process.argv[2];

if (!root) {
  throw new Error('Missing target root path.');
}

const dataDir = path.join(root, 'data');
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'aicoursenote.sqlite');
const SQL = await initSqlJs();
const db = new SQL.Database();

db.run(`
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE notebooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE notes (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, title TEXT NOT NULL, content_html TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE transcript_sessions (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, note_id TEXT, title TEXT NOT NULL, status TEXT NOT NULL, source_type TEXT NOT NULL, language TEXT NOT NULL, provider TEXT, model TEXT, started_at TEXT NOT NULL, paused_at TEXT, ended_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE transcript_segments (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, note_id TEXT, speaker_label TEXT, text TEXT NOT NULL, normalized_text TEXT, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, duration_ms INTEGER NOT NULL, is_final INTEGER NOT NULL DEFAULT 0, sequence_no INTEGER NOT NULL, confidence REAL, raw_payload TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE ai_analysis_jobs (id TEXT PRIMARY KEY, notebook_id TEXT NOT NULL, note_id TEXT, session_id TEXT, analysis_type TEXT NOT NULL, status TEXT NOT NULL, provider TEXT, model TEXT, prompt_version TEXT, input_hash TEXT, error_message TEXT, started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE ai_analysis_results (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, result_type TEXT NOT NULL, title TEXT NOT NULL, content_markdown TEXT NOT NULL, content_json TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
`);

const timestamp = new Date().toISOString();
db.run(`INSERT INTO metadata (key, value) VALUES ('schemaVersion', '3')`);
db.run(
  `INSERT INTO app_settings (key, value, updated_at)
   VALUES
   ('asrProvider', 'dashscope-asr', ?),
   ('asrModel', 'qwen3-asr-flash-realtime', ?),
   ('llmProvider', 'deepseek', ?),
   ('llmModel', 'deepseek-chat', ?),
   ('asrApiKey', 'legacy-asr-secret-1234', ?),
   ('llmApiKey', 'legacy-llm-secret-5678', ?)`,
  [timestamp, timestamp, timestamp, timestamp, timestamp, timestamp]
);

fs.writeFileSync(dbPath, Buffer.from(db.export()));
console.log(dbPath);
