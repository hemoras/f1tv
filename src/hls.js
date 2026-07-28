import { UserError } from './errors.js';

/**
 * Parse une liste d'attributs HLS de la forme :
 * KEY1=VALUE1,KEY2="valeur entre guillemets, avec virgule",KEY3=VALUE3
 */
function parseAttributeList(str) {
  const result = {};
  const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    const key = match[1];
    const value = match[2] !== undefined ? match[2] : match[3];
    result[key] = value;
  }
  return result;
}

function resolveUrl(baseUrl, uri) {
  return new URL(uri, baseUrl).toString();
}

async function fetchPlaylistText(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new UserError(`Impossible de recuperer la playlist video (${err.message}).`);
  }
  if (!response.ok) {
    throw new UserError(`Impossible de recuperer la playlist video (HTTP ${response.status}).`);
  }
  return response.text();
}

/**
 * Analyse une playlist maitre HLS (.m3u8) et en extrait :
 * - les variantes video disponibles (#EXT-X-STREAM-INF)
 * - toutes les pistes audio alternatives (#EXT-X-MEDIA de type AUDIO)
 */
export function parseMasterPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const videoVariants = [];
  const audioTracks = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO/.test(line)) {
      const attrs = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      if (attrs.URI) {
        audioTracks.push({
          groupId: attrs['GROUP-ID'] || '',
          name: attrs.NAME || attrs.LANGUAGE || 'Audio',
          language: attrs.LANGUAGE || null,
          isDefault: attrs.DEFAULT === 'YES',
          url: resolveUrl(baseUrl, attrs.URI),
        });
      }
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      const uriLine = lines[i + 1]?.trim();
      if (uriLine && !uriLine.startsWith('#')) {
        videoVariants.push({
          bandwidth: Number(attrs.BANDWIDTH || 0),
          resolution: attrs.RESOLUTION || null,
          audioGroup: attrs.AUDIO || null,
          url: resolveUrl(baseUrl, uriLine),
        });
      }
    }
  }

  return { videoVariants, audioTracks };
}

/**
 * Recupere la playlist maitre F1TV et en extrait la meilleure variante video
 * (la plus haute qualite disponible) ainsi que toutes les pistes audio
 * disponibles (dedupliquees par URL).
 */
export async function getVideoAndAudioTracks(masterPlaylistUrl) {
  const text = await fetchPlaylistText(masterPlaylistUrl);
  const { videoVariants, audioTracks } = parseMasterPlaylist(text, masterPlaylistUrl);

  if (videoVariants.length === 0) {
    throw new UserError('Aucune piste video trouvee dans la playlist F1TV (format inattendu).');
  }

  const bestVideo = videoVariants.reduce((best, variant) => (variant.bandwidth > best.bandwidth ? variant : best));

  const seenUrls = new Set();
  const uniqueAudioTracks = [];
  for (const track of audioTracks) {
    if (seenUrls.has(track.url)) continue;
    seenUrls.add(track.url);
    uniqueAudioTracks.push(track);
  }

  if (uniqueAudioTracks.length === 0) {
    throw new UserError('Aucune piste audio trouvee dans la playlist F1TV (format inattendu).');
  }

  return { video: bestVideo, audioTracks: uniqueAudioTracks };
}
