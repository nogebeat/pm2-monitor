"use strict";

/**
 * Chiffrement au repos des secrets EMBARQUÉS DANS UN BACKUP (Phase 19 —
 * Backup & Restore). Même algorithme et même format de sortie que
 * lib/services/notifications/utils/crypto.js (AES-256-GCM, IV aléatoire par
 * valeur, "iv:authTag:ciphertext" en base64) — voir ce fichier pour la
 * justification du choix de l'algorithme ; on ne réinvente rien ici, on
 * réutilise le même mécanisme documenté avec une clé dédiée.
 *
 * Clé dédiée (BACKUP_ENCRYPTION_KEY, .env), volontairement DISTINCTE de
 * NOTIFICATIONS_ENCRYPTION_KEY : un backup est un fichier destiné à quitter
 * le process (téléchargé, copié, archivé) et à survivre à un redémarrage —
 * contrairement aux secrets de providers de notification chiffrés en base,
 * qui ne quittent jamais le serveur. Partager la même clé signifierait
 * qu'un backup contenant des secrets EN CLAIR déchiffrable reste
 * déchiffrable indéfiniment avec la clé "courante" de l'instance, y compris
 * après une rotation de NOTIFICATIONS_ENCRYPTION_KEY — une clé dédiée qu'on
 * peut faire tourner indépendamment est plus sûre.
 *
 * Contrairement à lib/services/notifications/utils/crypto.js, il N'Y A PAS
 * de repli sur une clé aléatoire éphémère générée en mémoire : un backup
 * chiffré avec une clé perdue au redémarrage serait un backup silencieusement
 * inexploitable — pire qu'une erreur explicite au moment de la demande de
 * secrets. Voir requireKey() : lève une erreur claire si
 * BACKUP_ENCRYPTION_KEY est absente au lieu de fabriquer une clé qui ne
 * survivra pas.
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommandé pour GCM

function isConfigured() {
  return !!process.env.BACKUP_ENCRYPTION_KEY;
}

function requireKey() {
  const raw = process.env.BACKUP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "BACKUP_ENCRYPTION_KEY non définie (.env) : impossible d'inclure des secrets dans le backup. " +
        "Définis cette variable (chaîne aléatoire, ex: `openssl rand -hex 32`) pour activer " +
        "l'inclusion chiffrée des secrets, ou laisse les secrets exclus du backup (comportement par défaut).",
    );
  }
  return crypto.createHash("sha256").update(String(raw)).digest();
}

/**
 * Chiffre une valeur JSON-sérialisable. Retourne une chaîne opaque
 * "iv:authTag:ciphertext" (base64), ou null si `value` est null/undefined.
 * Lève une erreur explicite si BACKUP_ENCRYPTION_KEY n'est pas configurée.
 */
function encrypt(value) {
  if (value === null || value === undefined) return null;
  const key = requireKey();
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
 * (clé différente de celle utilisée à l'export, backup corrompu…).
 */
function decrypt(payload) {
  if (payload === null || payload === undefined) return null;
  const [ivB64, authTagB64, ciphertextB64] = String(payload).split(":");
  if (!ivB64 || !authTagB64 || !ciphertextB64) {
    throw new Error("Valeur chiffrée invalide dans le backup (format inattendu).");
  }
  const key = requireKey();
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
      "Impossible de déchiffrer les secrets de ce backup (BACKUP_ENCRYPTION_KEY différente de " +
        "celle utilisée à l'export, ou fichier corrompu).",
    );
  }
  return JSON.parse(plaintext.toString("utf8"));
}

module.exports = { ALGORITHM, isConfigured, encrypt, decrypt };
