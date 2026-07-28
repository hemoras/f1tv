/**
 * Erreur "attendue" : le message est deja redige pour l'utilisateur final,
 * on n'affiche donc pas la pile d'appels technique associee.
 */
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}
