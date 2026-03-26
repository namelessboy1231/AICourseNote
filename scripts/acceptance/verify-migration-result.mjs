import fs from 'node:fs';
import path from 'node:path';
import initSqlJs from 'sql.js';
import keytar from 'keytar';

const root = process.argv[2];

if (!root) {
  throw new Error('Missing target root path.');
}

const dbPath = path.join(root, 'data', 'aicoursenote.sqlite');
const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync(dbPath));
const stmt = db.prepare('SELECT key, value FROM app_settings ORDER BY key');
const rows = [];

while (stmt.step()) {
  rows.push(stmt.getAsObject());
}

stmt.free();

const asr = await keytar.getPassword('AICourseNote', 'asr-api-key');
const llm = await keytar.getPassword('AICourseNote', 'llm-api-key');

console.log(
  JSON.stringify(
    {
      rows,
      secureStore: {
        asr,
        llm
      }
    },
    null,
    2
  )
);
