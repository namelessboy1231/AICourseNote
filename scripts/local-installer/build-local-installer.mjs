import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '../..');
const releaseDir = path.join(projectRoot, 'release');
const sourceAppDir = path.join(releaseDir, 'win-unpacked');
const templatesDir = path.join(scriptDir, 'templates');
const installerRoot = path.join(releaseDir, 'local-installer');
const packageRoot = path.join(installerRoot, 'AICourseNote-local-installer');
const payloadTargetDir = path.join(packageRoot, 'payload', 'AICourseNote');

async function ensureDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function main() {
  const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf-8'));
  const zipFilePath = path.join(releaseDir, `AICourseNote-${packageJson.version}-local-installer.zip`);

  await fs.access(sourceAppDir);
  await fs.rm(installerRoot, { recursive: true, force: true });
  await ensureDirectory(payloadTargetDir);

  await fs.cp(sourceAppDir, payloadTargetDir, { recursive: true });

  const templateFiles = await fs.readdir(templatesDir);
  for (const fileName of templateFiles) {
    await fs.copyFile(path.join(templatesDir, fileName), path.join(packageRoot, fileName));
  }

  const manifest = {
    productName: packageJson.build?.productName || packageJson.name,
    version: packageJson.version,
    builtAt: new Date().toISOString(),
    installMode: 'directory-local'
  };

  await fs.writeFile(path.join(packageRoot, 'installer-manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  try {
    await fs.rm(zipFilePath, { force: true });
  } catch {
  }

  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Compress-Archive -Path '${packageRoot}\\*' -DestinationPath '${zipFilePath}' -Force`
    ],
    {
      cwd: projectRoot,
      stdio: 'inherit'
    }
  );

  console.log(`Local installer bundle created at: ${zipFilePath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
