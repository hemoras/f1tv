const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

function sanitize(text) {
  return text.replace(ILLEGAL_CHARS, '-').trim();
}

/**
 * Construit le nom de fichier final selon la convention demandee :
 * "[manche] GP [grand_prix] [saison] - [session] (F1TV).mkv"
 * ou, pour la course : "[manche] GP [grand_prix] [saison] (F1TV).mkv"
 *
 * Si un flux (-flux, ex : "Live Timing") est fourni :
 * "[manche] GP [grand_prix] [saison] - [session] ([flux] - F1TV).mkv"
 * ou, pour la course : "[manche] GP [grand_prix] [saison] - [flux] (F1TV).mkv"
 *
 * Extension .mkv (et non .mp4) car le fichier final contient plusieurs
 * pistes audio assemblees avec mkvmerge.
 */
export function buildFileName({ manche, grandPrix, saison, session, flux }) {
  const mancheFormatee = String(manche).padStart(2, '0');
  const grandPrixSanitized = sanitize(grandPrix);
  const fluxSanitized = flux ? sanitize(flux) : null;
  const isCourse = session.trim().toLowerCase() === 'course';

  if (isCourse) {
    if (!fluxSanitized) {
      return `${mancheFormatee} GP ${grandPrixSanitized} ${saison} (F1TV).mkv`;
    }
    return `${mancheFormatee} GP ${grandPrixSanitized} ${saison} - ${fluxSanitized} (F1TV).mkv`;
  }

  const sessionSanitized = sanitize(session);
  if (!fluxSanitized) {
    return `${mancheFormatee} GP ${grandPrixSanitized} ${saison} - ${sessionSanitized} (F1TV).mkv`;
  }
  return `${mancheFormatee} GP ${grandPrixSanitized} ${saison} - ${sessionSanitized} (${fluxSanitized} - F1TV).mkv`;
}
