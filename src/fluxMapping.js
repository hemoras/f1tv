import { UserError } from './errors.js';

/**
 * Correspondance entre le nom de flux (-flux) demande par l'utilisateur et le
 * channelId F1TV a utiliser dans l'URL de lecture. Stocke ici (comme
 * sessionNameMapping.js) plutot que dans .env : ce sont des donnees
 * d'application fixes, pas un reglage propre a l'environnement.
 */
export const FLUX_CHANNEL_MAPPING = {
  'Live Timing': '1004',
  'Drivers Tracker': '1004',
  'F1 Live': '1033',
};

/**
 * Renvoie le channelId correspondant a un nom de flux. Leve une erreur claire
 * si le flux demande n'est pas reconnu.
 */
export function getChannelId(fluxName) {
  const channelId = FLUX_CHANNEL_MAPPING[fluxName];
  if (channelId === undefined) {
    const available = Object.keys(FLUX_CHANNEL_MAPPING).join(', ');
    throw new UserError(`Flux "${fluxName}" inconnu. Flux disponibles : ${available}.`);
  }
  return channelId;
}
