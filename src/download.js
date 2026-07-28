import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UserError } from './errors.js';
import { logger } from './logger.js';

const TIME_REGEX = /time=(\d{2}):(\d{2}):(\d{2})/;

function parseElapsedSeconds(ffmpegLine) {
  const match = ffmpegLine.match(TIME_REGEX);
  if (!match) return null;
  const [, hours, minutes, seconds] = match;
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}

function runFfmpeg(args, onProgress) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', args);
    let stderrBuffer = '';

    ffmpeg.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrBuffer += text;
      if (stderrBuffer.length > 8000) {
        stderrBuffer = stderrBuffer.slice(-8000);
      }
      if (onProgress) {
        const elapsed = parseElapsedSeconds(text);
        if (elapsed !== null) onProgress(elapsed);
      }
    });

    ffmpeg.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new UserError(
            "ffmpeg est introuvable sur cette machine. Merci de l'installer et de t'assurer qu'il est accessible dans le PATH."
          )
        );
      } else {
        reject(err);
      }
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new UserError(
            `Le telechargement d'une piste a echoue (ffmpeg, code ${code}).\n` +
              `Derniers details techniques :\n${stderrBuffer.slice(-1500)}`
          )
        );
      }
    });
  });
}

/**
 * Telecharge un flux HLS (video seule ou piste audio seule) vers un fichier local.
 * Le CDN video est auto-authentifie via un token integre dans l'URL : on ne lui
 * envoie donc pas le (tres volumineux) cookie F1TV, seulement un Referer.
 *
 * progressLabel est optionnel : quand plusieurs flux sont telecharges en
 * parallele (pistes audio), on evite d'afficher une progression en direct
 * pour chacun (les mises a jour se melangeraient sur une seule ligne).
 */
function downloadStream(streamUrl, destinationPath, progressLabel) {
  const args = [
    '-y',
    '-headers',
    'Referer: https://f1tv.formula1.com/\r\n',
    '-i',
    streamUrl,
    '-c',
    'copy',
    destinationPath,
  ];

  if (!progressLabel) {
    return runFfmpeg(args);
  }

  let lastUpdateAt = 0;
  return runFfmpeg(args, (elapsed) => {
    const now = Date.now();
    if (now - lastUpdateAt < 500) return;
    lastUpdateAt = now;
    logger.progress(`  ${progressLabel} : ${formatDuration(elapsed)} deja telechargees...`);
  });
}

/**
 * Execute worker(item) pour chaque element de items, avec au plus `limit`
 * executions en parallele. Renvoie les resultats dans le meme ordre que items.
 */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runNext() {
    const index = cursor++;
    if (index >= items.length) return;
    results[index] = await worker(items[index], index);
    await runNext();
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, runNext));

  return results;
}

function normalizeLanguageCode(language) {
  if (!language) return 'und';
  const code = language.trim().toLowerCase();
  // "fx" est un code interne F1TV (flux sans commentaire / son d'ambiance),
  // pas un code de langue ISO 639 valide : mkvmerge le rejette sinon.
  if (code === 'fx') return 'und';
  return code;
}

/**
 * Assemble un fichier video et une ou plusieurs pistes audio en un seul .mkv
 * via mkvmerge, en conservant le nom et la langue de chaque piste audio.
 */
function muxToMkv(videoFile, audioFiles, destinationPath) {
  return new Promise((resolve, reject) => {
    const args = ['-o', destinationPath, '--language', '0:und', videoFile];

    for (const { file, track } of audioFiles) {
      args.push('--language', `0:${normalizeLanguageCode(track.language)}`);
      args.push('--track-name', `0:${track.name}`);
      if (track.isDefault) {
        args.push('--default-track-flag', '0:yes');
      }
      args.push(file);
    }

    const mkvmerge = spawn('mkvmerge', args);
    let outputBuffer = '';

    mkvmerge.stdout.on('data', (chunk) => {
      outputBuffer += chunk.toString();
      if (outputBuffer.length > 8000) outputBuffer = outputBuffer.slice(-8000);
    });
    mkvmerge.stderr.on('data', (chunk) => {
      outputBuffer += chunk.toString();
      if (outputBuffer.length > 8000) outputBuffer = outputBuffer.slice(-8000);
    });

    mkvmerge.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(
          new UserError(
            "mkvmerge est introuvable sur cette machine. Merci d'installer MKVToolNix et de t'assurer qu'il est accessible dans le PATH."
          )
        );
      } else {
        reject(err);
      }
    });

    mkvmerge.on('close', (code) => {
      // mkvmerge renvoie 0 (succes), 1 (succes avec avertissements) ou 2 (echec).
      if (code === 0 || code === 1) {
        resolve();
      } else {
        reject(
          new UserError(`L'assemblage du fichier final a echoue (mkvmerge, code ${code}).\n${outputBuffer.slice(-1500)}`)
        );
      }
    });
  });
}

/**
 * Telecharge la piste video et toutes les pistes audio fournies, puis les
 * assemble en un seul fichier .mkv. Les fichiers intermediaires sont
 * telecharges dans un dossier temporaire, nettoye a la fin (succes ou echec).
 *
 * Les pistes audio sont telechargees en parallele, jusqu'a `maxParallelAudio`
 * a la fois (reglable via F1TV_MAX_PARALLEL_AUDIO dans .env).
 */
export async function downloadAndMux({ videoUrl, audioTracks, destinationPath, maxParallelAudio = 3 }) {
  const destinationDir = path.dirname(destinationPath);
  if (!existsSync(destinationDir)) {
    mkdirSync(destinationDir, { recursive: true });
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'f1tv-'));

  try {
    const videoFile = path.join(tempDir, 'video.mp4');
    logger.info('Telechargement de la piste video...');
    await downloadStream(videoUrl, videoFile, 'Video');

    const parallelCount = Math.min(maxParallelAudio, audioTracks.length);
    logger.info(
      audioTracks.length > 1
        ? `Telechargement de ${audioTracks.length} pistes audio (${parallelCount} en parallele)...`
        : 'Telechargement de la piste audio...'
    );

    const audioFiles = await mapWithConcurrency(audioTracks, maxParallelAudio, async (track, index) => {
      const audioFile = path.join(tempDir, `audio_${index}.m4a`);
      await downloadStream(track.url, audioFile);
      logger.info(`  Piste audio "${track.name}" telechargee.`);
      return { file: audioFile, track };
    });

    logger.info('Assemblage du fichier final (mkvmerge)...');
    await muxToMkv(videoFile, audioFiles, destinationPath);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
