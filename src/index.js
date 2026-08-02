import path from 'node:path';
import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';

import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { UserError } from './errors.js';
import { loadCookieHeader } from './cookies.js';
import { createPool, getF1tvSaisonId, getGrandPrix, getManches } from './db.js';
import { F1TV_HOST, findGpPageId, findSessionContentId, findAllSessions, getVideoUrl } from './f1tvApi.js';
import { getVideoAndAudioTracks, filterAudioTracks } from './hls.js';
import { buildFileName } from './filename.js';
import { downloadAndMux } from './download.js';
import { getChannelId } from './fluxMapping.js';

function printUsage() {
  console.log(
    [
      'Usage :',
      '  node src/index.js -saison <annee> [-manche <numero>|<numero>+|all] [-session "<nom de la session>"] [-audio <code>|no]',
      '',
      'Exemples :',
      '  node src/index.js -saison 2026 -manche 11 -session "Essais Libres 1"   (telecharge cette video, toutes les pistes audio)',
      '  node src/index.js -saison 2026 -manche 11                              (liste les sessions dispo pour la manche 11, sans telecharger)',
      '  node src/index.js -saison 2026 -manche all -session "Course"           (telecharge la course de chaque manche de la saison)',
      '  node src/index.js -saison 2026 -manche 9+ -session "Course"            (telecharge la course de la manche 9 a la derniere de la saison)',
      '  node src/index.js -saison 2026                                        (liste les sessions dispo pour toute la saison, sans telecharger)',
      '  node src/index.js -saison 2026 -manche 11 -session "Course" -audio en  (uniquement la piste audio anglaise)',
      '  node src/index.js -saison 2026 -manche 11 -session "Course" -audio no  (video seule, sans aucune piste audio)',
      '  node src/index.js -saison 2026 -manche 11 -session "Course" -flux "Live Timing"  (autre angle/flux)',
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
      audio: { type: 'string' },
      flux: { type: 'string' },
    },
    strict: false,
  });

  return values;
}

/**
 * Determine la liste des manches a traiter : une seule manche, une manche et
 * toutes les suivantes (syntaxe "9+"), ou toutes celles de la saison si
 * -manche est absent ou vaut "all".
 */
async function resolveManches(pool, saison, args) {
  const raw = args.manche ? String(args.manche).trim() : '';

  if (!raw || raw.toLowerCase() === 'all') {
    return getManches(pool, saison);
  }

  if (raw.endsWith('+')) {
    const debut = Number(raw.slice(0, -1));
    if (!Number.isInteger(debut)) {
      throw new UserError('Le parametre -manche doit etre un nombre entier, eventuellement suivi de "+" (ex : "9+"), ou "all".');
    }
    const toutesLesManches = await getManches(pool, saison);
    const manches = toutesLesManches.filter((m) => m >= debut);
    if (manches.length === 0) {
      throw new UserError(`Aucune manche >= ${debut} trouvee pour la saison ${saison}.`);
    }
    return manches;
  }

  const manche = Number(raw);
  if (!Number.isInteger(manche)) {
    throw new UserError('Le parametre -manche doit etre un nombre entier, eventuellement suivi de "+" (ex : "9+"), ou "all".');
  }
  return [manche];
}

/**
 * Telecharge une session precise (video + toutes les pistes audio) et
 * l'assemble en .mkv. Ne fait rien (et ne contacte pas F1TV) si le fichier
 * final existe deja : permet de rejouer une commande (ex : saison complete
 * sans -manche) sans retelecharger ce qui est deja present.
 */
async function downloadSession({ config, cookieHeader, saison, manche, grandPrix, sessionInfo, audioArg, flux, channelId }) {
  const { session, contentId } = sessionInfo;

  const fileName = buildFileName({ manche, grandPrix, saison, session, flux });
  const destinationPath = path.resolve(config.destDir, fileName);

  if (existsSync(destinationPath)) {
    logger.info(`Deja telecharge, ignore : "${fileName}"`);
    return { skipped: true };
  }

  logger.info(
    flux
      ? `Recuperation du lien de la video pour "${session}" (flux "${flux}")...`
      : `Recuperation du lien de la video pour "${session}"...`
  );
  const masterPlaylistUrl = await getVideoUrl(cookieHeader, contentId, channelId);

  logger.info('Analyse des pistes disponibles...');
  const { video, audioTracks: allAudioTracks } = await getVideoAndAudioTracks(masterPlaylistUrl);
  logger.info(
    `${allAudioTracks.length} piste(s) audio disponible(s) : ${allAudioTracks.map((t) => t.name).join(', ')}`
  );

  const audioTracks = filterAudioTracks(allAudioTracks, audioArg);
  if (audioArg) {
    logger.info(
      audioTracks.length > 0
        ? `Piste(s) audio retenue(s) (-audio ${audioArg}) : ${audioTracks.map((t) => t.name).join(', ')}`
        : 'Aucune piste audio ne sera telechargee (-audio no).'
    );
  }

  logger.info(`Telechargement vers "${fileName}"...`);
  await downloadAndMux({
    videoUrl: video.url,
    audioTracks,
    destinationPath,
    maxParallelAudio: config.maxParallelAudio,
  });

  logger.success(`Video telechargee avec succes : ${fileName}`);
  return { skipped: false };
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

  // -flux (autre angle/camera) : valide des le depart pour echouer immediatement
  // si le nom donne n'est pas reconnu, plutot que de le decouvrir manche apres manche.
  const flux = args.flux ? String(args.flux) : null;
  const channelId = flux ? getChannelId(flux) : '';

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
    let skippedCount = 0;
    let failureCount = 0;

    for (const manche of manches) {
      try {
        const grandPrix = await getGrandPrix(pool, saison, manche);
        logger.info(`--- Manche ${manche} : ${grandPrix} ---`);

        const { pageId: gpPageId, meetingKey, directSessions } = await findGpPageId(cookieHeader, f1tvSaisonId, manche);

        // Sur les saisons anciennes, il n'y a pas de page dediee par Grand Prix :
        // la page saison contient deja directement les videos disponibles
        // (replay, resume...), sans page a interroger separement.
        if (isListingMode) {
          if (directSessions) {
            logger.info(
              `${directSessions.length} session(s) disponible(s) pour "${grandPrix}" (pas de page dediee sur cette saison) :`
            );
            for (const sessionInfo of directSessions) {
              logger.info(`  - ${sessionInfo.session}`);
            }
          } else {
            const sessions = await findAllSessions(cookieHeader, gpPageId, meetingKey);
            logger.info(`${sessions.length} session(s) disponible(s) pour "${grandPrix}" :`);
            for (const sessionInfo of sessions) {
              logger.info(`  - ${sessionInfo.session}`);
            }
          }
          continue;
        }

        let contentId;
        if (directSessions) {
          const found = directSessions.find((s) => s.session === session);
          if (!found) {
            const available = directSessions.map((s) => s.session).join(', ');
            throw new UserError(
              `Session "${session}" introuvable pour cette manche sur cette saison. Sessions disponibles : ${available}.`
            );
          }
          contentId = found.contentId;
        } else {
          contentId = await findSessionContentId(cookieHeader, gpPageId, meetingKey, session);
        }

        try {
          const result = await downloadSession({
            config,
            cookieHeader,
            saison,
            manche,
            grandPrix,
            sessionInfo: { session, contentId },
            audioArg: args.audio,
            flux,
            channelId,
          });
          if (result.skipped) {
            skippedCount += 1;
          } else {
            successCount += 1;
          }
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
      if (successCount + skippedCount + failureCount > 1) {
        logger.info(
          `Termine : ${successCount} video(s) telechargee(s), ${skippedCount} deja presente(s) (ignoree(s)), ${failureCount} echec(s).`
        );
      }
      // Erreur uniquement si rien n'a abouti du tout (ni telechargement, ni fichier deja present).
      if (failureCount > 0 && successCount === 0 && skippedCount === 0) {
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
