import keytar from 'keytar';

await keytar.deletePassword('AICourseNote', 'asr-api-key');
await keytar.deletePassword('AICourseNote', 'llm-api-key');

console.log('secure-store-cleaned');
