import mysql from 'mysql2/promise';
import { UserError } from './errors.js';

export function createPool(dbConfig) {
  return mysql.createPool({
    host: dbConfig.host,
    port: dbConfig.port,
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    waitForConnections: true,
    connectionLimit: 5,
  });
}

/**
 * Recupere l'identifiant F1TV de la page "saison" (table f1tv_saison).
 * Cette table doit deja etre renseignee manuellement.
 */
export async function getF1tvSaisonId(pool, saison) {
  const [rows] = await pool.query('SELECT f1tv_id FROM f1tv_saison WHERE saison = ?', [saison]);
  if (rows.length === 0) {
    throw new UserError(
      `Aucune information trouvee pour la saison ${saison} dans la table f1tv_saison. ` +
        `Merci d'ajouter une ligne (saison, f1tv_id) pour cette saison avant de relancer le script.`
    );
  }
  return rows[0].f1tv_id;
}

/**
 * Recupere le nom du Grand Prix (table statsf1_grand_prix) a partir de la saison et de la manche.
 */
export async function getGrandPrix(pool, saison, manche) {
  const [rows] = await pool.query(
    'SELECT grand_prix FROM statsf1_grand_prix WHERE saison = ? AND manche = ?',
    [saison, manche]
  );
  if (rows.length === 0) {
    throw new UserError(
      `Aucun Grand Prix trouve pour la saison ${saison}, manche ${manche} dans la table statsf1_grand_prix.`
    );
  }
  if (!rows[0].grand_prix) {
    throw new UserError(
      `Le Grand Prix de la saison ${saison}, manche ${manche} n'a pas de nom renseigne (colonne grand_prix) dans statsf1_grand_prix.`
    );
  }
  return rows[0].grand_prix;
}

/**
 * Liste les numeros de manche disponibles pour une saison (table statsf1_grand_prix),
 * utilise quand -manche vaut "all" ou n'est pas renseigne.
 */
export async function getManches(pool, saison) {
  const [rows] = await pool.query(
    'SELECT manche FROM statsf1_grand_prix WHERE saison = ? ORDER BY manche ASC',
    [saison]
  );
  if (rows.length === 0) {
    throw new UserError(`Aucun Grand Prix trouve pour la saison ${saison} dans la table statsf1_grand_prix.`);
  }
  return rows.map((row) => row.manche);
}
