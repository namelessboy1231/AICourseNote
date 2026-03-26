import fs from 'node:fs';
import initSqlJs from 'sql.js';
import keytar from 'keytar';

const dbPath = process.argv[2];

if (!dbPath) {
  throw new Error('Missing database path.');
}

const SQL = await initSqlJs();
const db = new SQL.Database(fs.readFileSync(dbPath));

function getValue(key) {
  const stmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  stmt.bind([key]);
  const value = stmt.step() ? stmt.getAsObject().value : '';
  stmt.free();
  return String(value || '').trim();
}

const asr = getValue('asrApiKey');
const llm = getValue('llmApiKey');

if (asr) {
  await keytar.setPassword('AICourseNote', 'asr-api-key', asr);
}

if (llm) {
  await keytar.setPassword('AICourseNote', 'llm-api-key', llm);
}

db.run('DELETE FROM app_settings WHERE key IN (?, ?)', ['asrApiKey', 'llmApiKey']);
fs.writeFileSync(dbPath, Buffer.from(db.export()));

console.log(
  JSON.stringify({
    migratedAsr: Boolean(asr),
    migratedLlm: Boolean(llm)
  })
);
