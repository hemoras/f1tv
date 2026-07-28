/**
 * Logs simples et lisibles pour suivre l'avancement du script.
 * Les details techniques (piles d'erreurs, etc.) ne sont affiches
 * qu'en cas d'erreur inattendue, via logger.debug().
 */
function timestamp() {
  return new Date().toLocaleTimeString('fr-FR');
}

// Pour logger.progress() : la derniere ligne de progression est reecrite en
// place (retour chariot) plutot que d'empiler une nouvelle ligne a chaque
// mise a jour. Tout autre log "normal" cloture proprement cette ligne avant
// de s'afficher.
let progressActive = false;
let lastProgressLength = 0;

function endProgress() {
  if (progressActive) {
    process.stdout.write('\n');
    progressActive = false;
    lastProgressLength = 0;
  }
}

export const logger = {
  info(message) {
    endProgress();
    console.log(`[${timestamp()}] ${message}`);
  },
  success(message) {
    endProgress();
    console.log(`[${timestamp()}] ${message}`);
  },
  warn(message) {
    endProgress();
    console.warn(`[${timestamp()}] Attention : ${message}`);
  },
  error(message) {
    endProgress();
    console.error(`[${timestamp()}] Erreur : ${message}`);
  },
  debug(details) {
    // Details techniques, affiches uniquement pour les erreurs inattendues.
    endProgress();
    console.error(details);
  },
  /**
   * Affiche une ligne de progression qui se met a jour en place (utile pour
   * les telechargements : evite de spammer une nouvelle ligne toutes les
   * quelques secondes).
   */
  progress(message) {
    const line = `[${timestamp()}] ${message}`;
    const padded = line.length < lastProgressLength ? line.padEnd(lastProgressLength, ' ') : line;
    process.stdout.write(`\r${padded}`);
    lastProgressLength = line.length;
    progressActive = true;
  },
};
