import keytar from 'keytar';

export type SecureApiKeyName = 'asrApiKey' | 'llmApiKey';

const SERVICE_NAME = 'AICourseNote';

const ACCOUNT_MAP: Record<SecureApiKeyName, string> = {
  asrApiKey: 'asr-api-key',
  llmApiKey: 'llm-api-key'
};

function maskApiKey(value: string) {
  if (!value) {
    return null;
  }

  if (value.length <= 8) {
    return `${value.slice(0, 2)}****`;
  }

  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export async function getSecureApiKey(name: SecureApiKeyName) {
  return (await keytar.getPassword(SERVICE_NAME, ACCOUNT_MAP[name])) ?? '';
}

export async function setSecureApiKey(name: SecureApiKeyName, value: string) {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    await deleteSecureApiKey(name);
    return;
  }

  await keytar.setPassword(SERVICE_NAME, ACCOUNT_MAP[name], normalizedValue);
}

export async function deleteSecureApiKey(name: SecureApiKeyName) {
  await keytar.deletePassword(SERVICE_NAME, ACCOUNT_MAP[name]);
}

export async function clearAllSecureApiKeys() {
  await Promise.all(Object.keys(ACCOUNT_MAP).map((key) => deleteSecureApiKey(key as SecureApiKeyName)));
}

export async function getSecureApiKeyMeta(name: SecureApiKeyName) {
  const value = await getSecureApiKey(name);

  return {
    configured: Boolean(value),
    preview: maskApiKey(value)
  };
}
