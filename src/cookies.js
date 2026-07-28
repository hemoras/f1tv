import { readFileSync, existsSync } from 'node:fs';
import { UserError } from './errors.js';

/**
 * Lit un fichier de cookies au format Netscape (celui exporte par la plupart
 * des extensions navigateur) et construit le header "Cookie" a utiliser pour
 * les appels vers un domaine donne (ex : f1tv.formula1.com).
 */
export function loadCookieHeader(cookieFilePath, host) {
  if (!existsSync(cookieFilePath)) {
    throw new UserError(
      `Le fichier de cookies "${cookieFilePath}" est introuvable. Verifie le chemin F1TV_COOKIE_FILE dans le fichier .env.`
    );
  }

  const content = readFileSync(cookieFilePath, 'utf-8');
  const now = Math.floor(Date.now() / 1000);
  const cookies = [];

  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      // Les cookies HttpOnly sont prefixes par "#HttpOnly_" dans le format Netscape,
      // ce sont des cookies valides malgre le "#" (les autres lignes sont des commentaires).
      if (line.startsWith('#HttpOnly_')) {
        line = line.slice('#HttpOnly_'.length);
      } else {
        continue;
      }
    }

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [domain, , , , expiry, name, value] = parts;
    const domainNormalized = domain.startsWith('.') ? domain.slice(1) : domain;
    const matchesHost = host === domainNormalized || host.endsWith(`.${domainNormalized}`);
    if (!matchesHost) continue;

    const expiryNumber = Number(expiry);
    const isExpired = expiryNumber !== 0 && expiryNumber < now;
    if (isExpired) continue;

    cookies.push(`${name}=${value}`);
  }

  if (cookies.length === 0) {
    throw new UserError(
      `Aucun cookie valide trouve pour "${host}" dans le fichier de cookies. Le cookie a peut-etre expire : merci de le regenerer depuis le site F1TV.`
    );
  }

  return cookies.join('; ');
}

/**
 * Extrait la valeur d'un cookie precis depuis un header "Cookie" deja construit
 * (chaine "name=value; name2=value2; ...").
 */
export function extractCookieValue(cookieHeader, cookieName) {
  for (const part of cookieHeader.split('; ')) {
    const separatorIndex = part.indexOf('=');
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex);
    if (name === cookieName) {
      return part.slice(separatorIndex + 1);
    }
  }
  return null;
}

/**
 * Le cookie "login-session" contient un JSON encode en URL avec la forme
 * { data: { subscriptionToken: "..." } }. Ce subscriptionToken est le token
 * attendu par le header "Ascendontoken" (different du cookie "entitlement_token").
 */
export function extractSubscriptionToken(cookieHeader) {
  const raw = extractCookieValue(cookieHeader, 'login-session');
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw);
    const parsed = JSON.parse(decoded);
    return parsed?.data?.subscriptionToken || null;
  } catch {
    return null;
  }
}
