/**
 * Correspondance entre le nom de session brut recupere depuis F1TV
 * (titleBrief pour les saisons recentes, contentSubtype pour les plus
 * anciennes) et le nom "affichable" utilise dans le nom de fichier final.
 * Toute valeur absente de cette table est conservee telle quelle.
 *
 * Stocke ici plutot que dans .env : ce sont des donnees d'application (pas
 * un reglage propre a l'environnement de la personne qui execute le script),
 * et .env gere mal le JSON avec accents/guillemets.
 */
export const SESSION_NAME_MAPPING = {
  REPLAY: 'Course',
  HIGHLIGHTS: 'Résumé',
  "Emission d'Avant-Course": 'Pre-Race',
  "Emission d'Après-Course": 'Post-Race',
  "Emission d'Avant-Qualifications": 'Pre-Qualifications',
  "Emission d'Après-Qualifications": 'Post-Qualifications',  
  "Essais 1": 'Essais Libres 1',
  "Essais 2": 'Essais Libres 2',
  "Essais 3": 'Essais Libres 3',
  "Essais 1 - Les Meilleurs Moments": 'Résumé Essais Libres 1',
  "Essais 2 - Les Meilleurs Moments": 'Résumé Essais Libres 2',
  "Essais 3 - Les Meilleurs Moments": 'Résumé Essais Libres 3',
  "Qualis Sprint": 'Qualifications Sprint',
  "Qualifs Sprint - Les Meilleurs Moments": 'Résumé Qualifications Sprint',
  "F1 Sprint": 'Course Sprint',
  "Sprint - Les Meilleurs Moments": 'Résumé Course Sprint',
  "La Course en 30min": "Résumé",
  "Conférence de Presse FIA d'Après Course": "Conférence de Presse",
  "Conférence de Presse d'Après Course Sprint": "Sprint - Conférence de Presse",
  "Conf de Presse FIA d'Après Essais Qualificatifs": "Qualifications - Conférence de Presse",
  "L'Analyse de Jolyon Palmer": "Jolyon Palmer Analysis",
  "FIA Conférence de presse des pilotes, groupe 1": "Drivers Press Conference 1",
  "FIA Conférence de presse des pilotes, groupe 2": "Drivers Press Conference 2",
  "Conférence de Presse FIA: Représentants de l'équip": "Teams Press Conference",
};

export function mapSessionName(rawName) {
  if (!rawName) return rawName;
  return SESSION_NAME_MAPPING[rawName] ?? rawName;
}
