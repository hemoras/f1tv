import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UserError } from './errors.js';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function required(name, value) {
  if (!value) {
    throw new UserError(
      `La variable d'environnement ${name} est manquante. Merci de completer le fichier .env (voir .env.example).`
    );
  }
  return value;
}

export function loadConfig() {
  const destDir = required('F1TV_DEST_DIR', process.env.F1TV_DEST_DIR);
  const cookieFileRaw = process.env.F1TV_COOKIE_FILE || './f1tv.formula1.com_cookies.txt';
  const cookieFile = path.isAbsolute(cookieFileRaw)
    ? cookieFileRaw
    : path.resolve(projectRoot, cookieFileRaw);

  const maxParallelAudioRaw = Number(process.env.F1TV_MAX_PARALLEL_AUDIO || 3);
  const maxParallelAudio =
    Number.isInteger(maxParallelAudioRaw) && maxParallelAudioRaw > 0 ? maxParallelAudioRaw : 3;

  return {
    destDir,
    cookieFile,
    maxParallelAudio,
    db: {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      database: required('DB_NAME', process.env.DB_NAME),
      user: required('DB_USER', process.env.DB_USER),
      password: process.env.DB_PASSWORD || '',
    },
  };
}
