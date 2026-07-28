import path from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { UserError } from './errors.js';
import { loadCookieHeader } from './cookies.js';
import { createPool, getF1tvSaisonId, getGrandPrix, getManches } from './db.js';
import { F1TV_HOST, findGpPageId, findSessionContentId, findAllSessions, getVideoUrl } from './f1tvApi.js';
import { getVideoAndAudioTracks } from './hls.js';
import { buildFileName } from './filename.js';
import { downloadAndMux } from './download.js';

function printUsage() {
  console.log(
    [
      'Usage :',
      '  node src/index.js -saison <annee> [-manche <numero>|all] [-session "<nom de la session>"]',
      '',
      'Exemples :',
      '  node src/index.js -saison 2026 -manche 11 -session "Essais Libres 1"   (telecharge cette video)',
      '  node src/index.js -saison 2026 -manche 11                              (liste les sessions dispo pour la manche 11, sans telecharger)',
      '  node src/index.js -saison 2026 -manche all -session "Course"           (telecharge la course de chaque manche de la saison)',
      '  node src/index.js -saison 2026                                        (liste les sessions dispo pour toute la saison, sans telecharger)',
    ].join('\n')
  );
}

function parseCliArgs(argv) {
  // On accepte aussi bien "-saison" que "--saison" pour rester proche
  // de la demande d'origine.
  const normalized = argv.map((arg) => (/^-[a-zA-Z]/.test(arg) && !arg.startsWith('--') ? `-${arg}` : arg));

  const { values } = parseArgs({
    args: normalized,
    options: {
      saison: { type: 'string' },
      manche: { type: 'string' },
      session: { type: 'string' },
    },
    strict: false,
  });

  return values;
}

/**
 * Determine la liste des manches a traiter : une seule manche, ou toutes
 * celles de la saison si -manche est absent ou vaut "all".
 */
async function resolveManches(pool, saison, args) {
  if (!args.manche || String(args.manche).trim().toLowerCase() === 'all') {
    return getManches(pool, saison);
  }
  const manche = Number(args.manche);
  if (!Number.isInteger(manche)) {
    throw new UserError('Le parametre -manche doit etre un nombre entier ou "all".');
  }
  return [manche];
}

/**
 * Telecharge une session precise (video + toutes les pistes audio) et
 * l'assemble en .mkv.
 */
async function downloadSession({ config, cookieHeader, saison, manche, grandPrix, sessionInfo }) {
  const { session, contentId } = sessionInfo;

  logger.info(`Recuperation du lien de la video pour "${session}"...`);
  const masterPlaylistUrl = await getVideoUrl(cookieHeader, contentId);

  logger.info('Analyse des pistes disponibles...');
  const { video, audioTracks } = await getVideoAndAudioTracks(masterPlaylistUrl);
  logger.info(`${audioTracks.length} piste(s) audio disponible(s) : ${audioTracks.map((t) => t.name).join(', ')}`);

  const fileName = buildFileName({ manche, grandPrix, saison, session });
  const destinationPath = path.resolve(config.destDir, fileName);

  if (existsSync(destinationPath)) {
    logger.warn(`Le fichier "${fileName}" existe deja, il va etre remplace.`);
  }

  logger.info(`Telechargement vers "${fileName}"...`);
  await downloadAndMux({
    videoUrl: video.url,
    audioTracks,
    destinationPath,
    maxParallelAudio: config.maxParallelAudio,
  });

  logger.success(`Video telechargee avec succes : ${fileName}`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (!args.saison) {
    printUsage();
    throw new UserError('Le parametre -saison est obligatoire.');
  }

  const saison = Number(args.saison);
  if (!Number.isInteger(saison)) {
    throw new UserError('Le parametre -saison doit etre un nombre entier.');
  }

  const config = loadConfig();
  const pool = createPool(config.db);

  try {
    const f1tvSaisonId = await getF1tvSaisonId(pool, saison);

    logger.info('Connexion a F1TV...');
    const cookieHeader = loadCookieHeader(config.cookieFile, F1TV_HOST);

    const manches = await resolveManches(pool, saison, args);
    logger.info(
      manches.length > 1
        ? `${manches.length} manche(s) a traiter pour la saison ${saison}.`
        : `Manche ${manches[0]} de la saison ${saison}.`
    );

    // Si -session n'est pas fourni, on se contente de lister les sessions
    // disponibles pour chaque manche, sans rien telecharger.
    const isListingMode = !args.session;
    const session = isListingMode ? null : String(args.session);

    let successCount = 0;
    let failureCount = 0;

    for (const manche of manches) {
      try {
        const grandPrix = await getGrandPrix(pool, saison, manche);
        logger.info(`--- Manche ${manche} : ${grandPrix} ---`);

        const { pageId: gpPageId, meetingKey } = await findGpPageId(cookieHeader, f1tvSaisonId, manche);

        if (isListingMode) {
          const sessions = await findAllSessions(cookieHeader, gpPageId, meetingKey);
          logger.info(`${sessions.length} session(s) disponible(s) pour "${grandPrix}" :`);
          for (const sessionInfo of sessions) {
            logger.info(`  - ${sessionInfo.session}`);
          }
          continue;
        }

        const contentId = await findSessionContentId(cookieHeader, gpPageId, meetingKey, session);

        try {
          await downloadSession({ config, cookieHeader, saison, manche, grandPrix, sessionInfo: { session, contentId } });
          successCount += 1;
        } catch (err) {
          failureCount += 1;
          if (err instanceof UserError) {
            logger.error(`Manche ${manche}, session "${session}" : ${err.message}`);
          } else {
            logger.error(`Manche ${manche}, session "${session}" : erreur inattendue.`);
            logger.debug(err);
          }
        }
      } catch (err) {
        failureCount += 1;
        if (err instanceof UserError) {
          logger.error(`Manche ${manche} : ${err.message}`);
        } else {
          logger.error(`Manche ${manche} : erreur inattendue.`);
          logger.debug(err);
        }
      }
    }

    if (!isListingMode) {
      if (successCount + failureCount > 1) {
        logger.info(`Termine : ${successCount} video(s) telechargee(s), ${failureCount} echec(s).`);
      }
      if (successCount === 0) {
        process.exitCode = 1;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  if (err instanceof UserError) {
    logger.error(err.message);
  } else {
    logger.error("Une erreur inattendue s'est produite.");
    logger.debug(err);
  }
  process.exitCode = 1;
});
