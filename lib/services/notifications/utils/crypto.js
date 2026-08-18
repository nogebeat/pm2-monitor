"use strict";

/**
 * Chiffrement au repos des secrets de providers de notification (SMTP
 * password, webhook Discord/Slack, bot token Telegram, headers
 * d'autorisation…) — voir lib/db/migrations/006_notifications.js, colonne
 * `notification_providers.secrets`.
 *
 * Le projet n'a jusqu'ici que du hachage à sens unique (bcrypt, pour les mots
 * de passe utilisateurs — lib/user-store.js) : inadapté ici, ces secrets
 * doivent être déchiffrables pour être effectivement utilisés par un
 * provider (Phase 5B/5C). AES-256-GCM est donc introduit spécifiquement pour
 * ce besoin (confidentialité + intégrité, vecteur d'initialisation aléatoire
 * par valeur chiffrée).
 *
 * Clé : NOTIFICATIONS_ENCRYPTION_KEY (.env), dérivée en 32 octets via SHA-256
 * (accepte n'importe quelle chaîne, pas seulement un hex de 64 caractères).
 * Si absente, une clé aléatoire est générée en mémoire au démarrage — même
 * choix que SESSION_SECRET (lib/auth.js) — avec un avertissement explicite :
 * contrairement aux sessions (juste une reconnexion à refaire), un redémarrage
 * sans clé explicite rend TOUS les secrets déjà stockés définitivement
 * indéchiffrables. À définir explicitement dès la Phase 5C (première
 * configuration réelle d'un provider) ; cette phase ne fait qu'établir
 * l'abstraction.
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommandé pour GCM

let warned = false;

function resolveKey() {
  const raw = process.env.NOTIFICATIONS_ENCRYPTION_KEY;
  if (raw) return crypto.createHash("sha256").update(String(raw)).digest();

  if (!warned) {
    console.warn(
      "⚠️  NOTIFICATIONS_ENCRYPTION_KEY non définie : une clé aléatoire a été générée en mémoire. " +
        "Tout secret de provider de notification déjà chiffré deviendra illisible au prochain " +
        "redémarrage. Définis NOTIFICATIONS_ENCRYPTION_KEY dans .env avant de configurer un vrai " +
        "provider (Phase 5C).",
    );
    warned = true;
  }
  return ephemeralKey();
}

let _ephemeralKey = null;
function ephemeralKey() {
  if (!_ephemeralKey) _ephemeralKey = crypto.randomBytes(32);
  return _ephemeralKey;
}

/**
 * Chiffre une valeur JSON-sérialisable. Retourne une chaîne opaque
 * "iv:authTag:ciphertext" (base64), ou null si `value` est null/undefined
 * (aucun secret à stocker).
 */
function encrypt(value) {
  if (value === null || value === undefined) return null;
  const key = resolveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

/**
 * Déchiffre une valeur produite par encrypt(). Retourne null si `payload`
 * est null/undefined. Lève une erreur explicite si le déchiffrement échoue
 * (clé changée depuis, valeur corrompue…) plutôt que de renvoyer un résultat
 * partiel ou silencieusement faux.
 */
function decrypt(payload) {
  if (payload === null || payload === undefined) return null;
  const [ivB64, authTagB64, ciphertextB64] = String(payload).split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Valeur chiffrée invalide (format inattendu).");
  }
  const key = resolveKey();
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  let plaintext;
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (e) {
    throw new Error(
      "Impossible de déchiffrer ce secret (clé NOTIFICATIONS_ENCRYPTION_KEY différente de celle " +
        "utilisée au chiffrement, ou donnée corrompue).",
    );
  }
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { encrypt, decrypt };
