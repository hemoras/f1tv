import { UserError } from './errors.js';
import { extractCookieValue, extractSubscriptionToken } from './cookies.js';
import { mapSessionName } from './sessionNameMapping.js';

export const F1TV_HOST = 'f1tv.formula1.com';
const BASE_URL = `https://${F1TV_HOST}`;

const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
};

// Identifie le lecteur comme un client web classique, requis par F1TV pour
// evaluer la regle de flux (regle DRM/plateforme) sur l'appel CONTENT/PLAY.
const DEVICE_INFO_HEADER =
  'device=web;screen=browser;os=windows;browser=chrome;browserVersion=150;osVersion=11;appVersion=52.0.6;playerVersion=8.212.0;p=false;tms=1';

async function callF1tvApi(pathAndQuery, cookieHeader, extraHeaders = {}) {
  const url = `${BASE_URL}${pathAndQuery}`;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        ...DEFAULT_HEADERS,
        Cookie: cookieHeader,
        ...extraHeaders,
      },
    });
  } catch (err) {
    throw new UserError(`Impossible de contacter F1TV (${err.message}). Verifie ta connexion internet.`);
  }

  if (response.status === 401 || response.status === 403) {
    throw new UserError(
      "Acces refuse par F1TV (cookie invalide ou expire). Merci de regenerer le fichier de cookies en te reconnectant sur f1tv.formula1.com."
    );
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText);
      detail = parsed.message || parsed.errorDescription || bodyText;
    } catch {
      // le corps n'est pas du JSON, on garde le texte brut
    }
    throw new UserError(
      `F1TV a repondu avec une erreur (HTTP ${response.status}) pour ${pathAndQuery}.` +
        (detail ? ` Detail : ${detail}` : '')
    );
  }

  return response.json();
}

/**
 * Parcourt recursivement un objet/tableau JSON et renvoie le premier noeud
 * (objet) qui satisfait le predicat donne. Parcours en profondeur, dans
 * l'ordre naturel des cles/elements.
 */
function findFirstMatch(node, predicate) {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findFirstMatch(item, predicate);
      if (found) return found;
    }
    return null;
  }

  if (node && typeof node === 'object') {
    if (predicate(node)) return node;
    for (const key of Object.keys(node)) {
      const found = findFirstMatch(node[key], predicate);
      if (found) return found;
    }
  }

  return null;
}

/**
 * Variante de findFirstMatch qui renvoie tous les noeuds correspondants
 * (meme parcours en profondeur).
 */
function findAllMatches(node, predicate, results = []) {
  if (Array.isArray(node)) {
    for (const item of node) {
      findAllMatches(item, predicate, results);
    }
    return results;
  }

  if (node && typeof node === 'object') {
    if (predicate(node)) results.push(node);
    for (const key of Object.keys(node)) {
      findAllMatches(node[key], predicate, results);
    }
  }

  return results;
}

function isUsable(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Recupere les informations du Grand Prix correspondant a une manche donnee,
 * a partir de la page "saison". Deux cas de figure existent selon la saison :
 *
 * - Saisons recentes : chaque manche est representee par une entree avec un
 *   PageID (Championship_Meeting_Ordinal -> PageID), qui pointe vers une page
 *   dediee au Grand Prix listant toutes ses sessions (FP1, Qualifs, Course...).
 * - Saisons anciennes : il n'y a pas de PageID du tout (Championship_Meeting_Ordinal
 *   est aussi vide) ; la page saison liste directement les videos disponibles
 *   pour la manche (en general plusieurs : le replay complet et le resume),
 *   sans page dediee. On renvoie alors directSessions avec ces videos ; le nom
 *   de session est tire de contentSubtype (REPLAY, HIGHLIGHTS...) plutot que de
 *   titleBrief (specifique a chaque GP, inutilisable comme identifiant generique),
 *   puis passe par mapSessionName() (REPLAY -> Course, HIGHLIGHTS -> Resume, ...).
 *
 * Pour identifier la manche, on utilise en priorite Championship_Meeting_Ordinal
 * (uniquement parmi les entrees ou il est effectivement renseigne : certaines
 * entrees, comme les essais de pre-saison, ont un Meeting_Number renseigne mais
 * un Championship_Meeting_Ordinal vide, il ne faut pas les laisser "masquer" le
 * vrai Grand Prix qui, lui, a un ordinal correct). Seulement si AUCUNE entree de
 * la reponse n'a d'ordinal utilisable (vieilles saisons), on se rabat sur
 * Meeting_Number ; en tout dernier recours, sur session_index.
 */
export async function findGpPageId(cookieHeader, f1tvSaisonId, manche) {
  const url = `/2.0/R/FRA/WEB_DASH/ALL/PAGE/${f1tvSaisonId}/ACCESS/5`;
  const data = await callF1tvApi(url, cookieHeader);

  const candidates = findAllMatches(data?.resultObj, (node) => {
    const emfAttributes = node.metadata?.emfAttributes;
    if (!emfAttributes) return false;
    const hasPageId = emfAttributes.PageID !== undefined && emfAttributes.PageID !== null;
    const hasDirectContent = node.metadata.contentId !== undefined;
    return hasPageId || hasDirectContent;
  });

  function matchOn(fieldName) {
    return candidates.filter((node) => {
      const value = node.metadata.emfAttributes[fieldName];
      return isUsable(value) && String(value) === String(manche);
    });
  }

  let matches = matchOn('Championship_Meeting_Ordinal');
  if (matches.length === 0) {
    // Aucune entree n'a d'ordinal utilisable pour cette manche : soit la saison
    // n'utilise pas ce champ du tout (vieilles saisons), soit la manche demandee
    // n'existe pas. On retente avec Meeting_Number, uniquement si vraiment aucune
    // entree de la reponse n'a d'ordinal renseigne (sinon on risquerait de
    // confondre une manche reelle avec un evenement hors championnat).
    const anyOrdinalUsable = candidates.some((node) => isUsable(node.metadata.emfAttributes.Championship_Meeting_Ordinal));
    if (!anyOrdinalUsable) {
      matches = matchOn('Meeting_Number');
      if (matches.length === 0) {
        matches = matchOn('session_index');
      }
    }
  }

  if (matches.length === 0) {
    throw new UserError(
      `Impossible de trouver le Grand Prix correspondant a la manche ${manche} sur la page F1TV de la saison. ` +
        `Verifie que le numero de manche est correct.`
    );
  }

  // Certaines entrees promotionnelles (ex : bandeau "hero" d'un GP a venir)
  // partagent le meme Championship_Meeting_Ordinal que la vraie entree du GP
  // mais n'ont pas de PageID exploitable : on privilegie toute entree ayant
  // un PageID valide plutot que de prendre la premiere trouvee au hasard.
  const hasValidPageId = (node) =>
    node.metadata.emfAttributes.PageID !== undefined && node.metadata.emfAttributes.PageID !== null;
  matches = [...matches.filter(hasValidPageId), ...matches.filter((node) => !hasValidPageId(node))];

  const first = matches[0];
  const firstEmfAttributes = first.metadata.emfAttributes;
  const meetingKey = firstEmfAttributes.MeetingKey ?? null;
  const hasPageId = firstEmfAttributes.PageID !== undefined && firstEmfAttributes.PageID !== null;

  if (hasPageId) {
    return { pageId: firstEmfAttributes.PageID, meetingKey, directSessions: null };
  }

  // Pas de page dediee (saisons anciennes) : la page saison contient deja
  // directement la ou les video(s) de la manche (replay, resume...).
  const seenContentSubtypes = new Set();
  const directSessions = [];
  for (const node of matches) {
    const rawName = node.metadata.contentSubtype || node.metadata.titleBrief;
    if (!rawName || seenContentSubtypes.has(rawName)) continue;
    seenContentSubtypes.add(rawName);
    directSessions.push({ session: mapSessionName(rawName), contentId: node.metadata.contentId });
  }

  return { pageId: null, meetingKey, directSessions };
}

/**
 * Recupere le contentId de la session recherchee sur la page du Grand Prix
 * (metadata.titleBrief, passe par mapSessionName(), + metadata.emfAttributes.Series
 * === "FORMULA 1", et MeetingKey correspondant a la manche demandee si connu).
 * S'il y a plusieurs resultats, seul le premier est conserve.
 */
export async function findSessionContentId(cookieHeader, gpPageId, meetingKey, session) {
  const data = await callF1tvApi(`/2.0/R/FRA/WEB_DASH/ALL/PAGE/${gpPageId}/ACCESS/5`, cookieHeader);

  const match = findFirstMatch(data?.resultObj, (node) => {
    const metadata = node.metadata;
    return (
      metadata &&
      mapSessionName(metadata.titleBrief) === session &&
      metadata.emfAttributes &&
      metadata.emfAttributes.Series === 'FORMULA 1' &&
      (!meetingKey || metadata.emfAttributes.MeetingKey === meetingKey) &&
      metadata.contentId !== undefined
    );
  });

  if (!match) {
    throw new UserError(
      `Impossible de trouver la session "${session}" pour ce Grand Prix. ` +
        `Verifie l'orthographe exacte de la session (ex : "Essais Libres 1", "Qualifications", "Course").`
    );
  }

  return match.metadata.contentId;
}

/**
 * Liste toutes les sessions FORMULA 1 disponibles sur la page du Grand Prix
 * (metadata.titleBrief + metadata.emfAttributes.Series === "FORMULA 1", et
 * MeetingKey correspondant a la manche demandee si connu).
 * La page F1TV peut lister plusieurs fois le meme titre de session (ex :
 * archives d'autres annees pour le meme circuit) : comme pour la recherche
 * d'une session precise, seule la premiere occurrence de chaque titre est
 * conservee, les autres sont ignorees.
 */
export async function findAllSessions(cookieHeader, gpPageId, meetingKey) {
  const data = await callF1tvApi(`/2.0/R/FRA/WEB_DASH/ALL/PAGE/${gpPageId}/ACCESS/5`, cookieHeader);

  const matches = findAllMatches(data?.resultObj, (node) => {
    const metadata = node.metadata;
    return (
      metadata &&
      typeof metadata.titleBrief === 'string' &&
      metadata.titleBrief.length > 0 &&
      metadata.emfAttributes &&
      metadata.emfAttributes.Series === 'FORMULA 1' &&
      (!meetingKey || metadata.emfAttributes.MeetingKey === meetingKey) &&
      metadata.contentId !== undefined
    );
  });

  const seenTitles = new Set();
  const sessions = [];
  for (const node of matches) {
    const title = node.metadata.titleBrief;
    if (seenTitles.has(title)) continue;
    seenTitles.add(title);

    const sessionIndexRaw = Array.isArray(node.properties) ? node.properties[0]?.session_index : undefined;
    const sessionIndex = typeof sessionIndexRaw === 'number' ? sessionIndexRaw : null;

    sessions.push({ session: mapSessionName(title), contentId: node.metadata.contentId, sessionIndex });
  }

  if (sessions.length === 0) {
    throw new UserError('Aucune session FORMULA 1 trouvee pour ce Grand Prix.');
  }

  // Ordre chronologique approximatif : F1TV utilise un session_index decroissant
  // pour les sessions les plus anciennes (les valeurs les plus hautes arrivent en premier).
  sessions.sort((a, b) => (b.sessionIndex ?? -1) - (a.sessionIndex ?? -1));

  return sessions;
}

/**
 * Recupere l'URL de lecture de la video (flux HLS) pour un contentId donne.
 * channelId permet de choisir un autre angle/flux (ex : "Live Timing",
 * "F1 Live") ; laisse vide, on recupere le flux principal.
 */
export async function getVideoUrl(cookieHeader, contentId, channelId = '') {
  // Cet appel exige plusieurs elements en plus du cookie, sans quoi F1TV renvoie
  // soit "Missing parameter Ascendon Token or Entitlement Token", soit
  // "Failed to evaluate stream rule" :
  //  - Entitlementtoken : le cookie "entitlement_token" tel quel.
  //  - Ascendontoken : le "subscriptionToken" imbrique dans le cookie "login-session"
  //    (different de l'entitlement_token : issu d'un JSON encode dans ce cookie).
  //  - X-F1-Device-Info : identifie le client comme un navigateur web, necessaire
  //    pour que F1TV puisse determiner la regle de flux applicable.
  const entitlementToken = extractCookieValue(cookieHeader, 'entitlement_token');
  if (!entitlementToken) {
    throw new UserError(
      'Le cookie "entitlement_token" est introuvable dans le fichier de cookies. ' +
        'Merci de regenerer le fichier de cookies en te reconnectant sur f1tv.formula1.com.'
    );
  }

  const ascendonToken = extractSubscriptionToken(cookieHeader);
  if (!ascendonToken) {
    throw new UserError(
      'Le cookie "login-session" est introuvable ou invalide dans le fichier de cookies. ' +
        'Merci de regenerer le fichier de cookies en te reconnectant sur f1tv.formula1.com.'
    );
  }

  const data = await callF1tvApi(
    `/3.0/R/FRA/WEB_HLS/ALL/CONTENT/PLAY?channelId=${channelId}&contentId=${contentId}&player=player_bm`,
    cookieHeader,
    {
      Entitlementtoken: entitlementToken,
      Ascendontoken: ascendonToken,
      'X-F1-Device-Info': DEVICE_INFO_HEADER,
    }
  );

  if (typeof data?.resultObj?.url === 'string') {
    return data.resultObj.url;
  }

  // Filet de securite si la structure de reponse differe de celle attendue :
  // on cherche specifiquement un champ "url" pointant vers un flux HLS (.m3u8),
  // pour eviter de recuperer par erreur une url sans rapport (ex : liveNow).
  const fallback = findFirstMatch(
    data?.resultObj,
    (node) => typeof node.url === 'string' && /\.m3u8(\?|$)/.test(node.url)
  );
  if (fallback) return fallback.url;

  throw new UserError(
    `F1TV n'a renvoye aucune URL de lecture pour cette video (contentId ${contentId}). ` +
      `Le contenu est peut-etre indisponible ou reserve a un autre abonnement.`
  );
}
