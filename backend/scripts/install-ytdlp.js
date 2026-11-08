// Downloads the standalone yt-dlp binary for this platform into backend/bin.
// Skipped when YTDLP_PATH points to an existing install or SKIP_YTDLP_DOWNLOAD=1.
import { chmod, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { arch, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download';
const binDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin');
const force = process.argv.includes('--force');

function assetName() {
  const p = platform();
  const a = arch();
  if (p === 'win32') return { asset: a === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe', file: 'yt-dlp.exe' };
  if (p === 'darwin') return { asset: 'yt-dlp_macos', file: 'yt-dlp' };
  if (p === 'linux') return { asset: a === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', file: 'yt-dlp' };
  return null;
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.env.SKIP_YTDLP_DOWNLOAD === '1') {
    console.log('[yt-dlp] download skipped (SKIP_YTDLP_DOWNLOAD=1)');
    return;
  }
  if (process.env.YTDLP_PATH && (await exists(process.env.YTDLP_PATH))) {
    console.log(`[yt-dlp] using ${process.env.YTDLP_PATH}`);
    return;
  }

  const target = assetName();
  if (!target) {
    console.warn(`[yt-dlp] no standalone build for ${platform()}/${arch()}; install yt-dlp and set YTDLP_PATH`);
    return;
  }

  const dest = join(binDir, target.file);
  if (!force && (await exists(dest))) {
    console.log(`[yt-dlp] already installed at ${dest}`);
    return;
  }

  console.log(`[yt-dlp] downloading ${target.asset} ...`);
  const res = await fetch(`${RELEASE_URL}/${target.asset}`);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  await mkdir(binDir, { recursive: true });
  const tmp = `${dest}.download`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, dest);
  if (platform() !== 'win32') await chmod(dest, 0o755);
  console.log(`[yt-dlp] installed at ${dest}`);
}

main().catch((err) => {
  console.error(`[yt-dlp] ${err.message}`);
  console.error('[yt-dlp] install yt-dlp manually and set YTDLP_PATH, or rerun: npm run ytdlp:install');
});
