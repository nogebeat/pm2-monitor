# Politique de sécurité

## Signaler une vulnérabilité

Si tu découvres une vulnérabilité de sécurité dans PM2 Monitor, merci de
**ne pas** ouvrir une issue publique.

À la place :

1. Utilise l'onglet **"Security" → "Report a vulnerability"** de GitHub
   (Security Advisories privés) si disponible sur ce dépôt, ou
2. Contacte directement un·e mainteneur·euse du projet en privé (voir la
   liste des contributeur·rice·s du dépôt).

Merci d'inclure autant de détails que possible :

- une description de la vulnérabilité et de son impact potentiel ;
- les étapes pour la reproduire (proof of concept si possible) ;
- la version du projet concernée (`package.json` → `version`) ;
- ton environnement (OS, version de Node.js, driver de base de données).

Nous nous engageons à accuser réception sous **72 heures** et à te tenir
informé·e de l'avancement de la correction.

## Points d'attention spécifiques à ce projet

PM2 Monitor donne accès à des actions sensibles (démarrer/arrêter des
process, exécuter `pm2 kill`, lire des logs applicatifs, gérer des
utilisateurs). Sont notamment considérés comme des vulnérabilités :

- toute façon de contourner l'authentification ou le système de
  permissions (`lib/permissions.js`) ;
- toute injection permettant d'exécuter des commandes arbitraires
  (attention particulière portée aux health checks de type `command`,
  voir `docs/health-checks/README.md#command`) ;
- toute fuite de secrets stockés (mots de passe SMTP, webhooks, tokens de
  bot — voir `lib/services/notifications/`) au-delà de ce qui est prévu par
  la conception (`hasSecrets` uniquement côté client, jamais la valeur en
  clair) ;
- toute façon de lire les logs ou données d'un·e utilisateur·rice sans les
  permissions requises.

## Versions supportées

Ce projet suit une politique de support simple : seule la **dernière
version publiée sur `main`** reçoit des correctifs de sécurité. Merci de
toujours te mettre à jour avant de signaler un problème, pour vérifier
qu'il n'est pas déjà corrigé.

## Bonnes pratiques de déploiement

Voir la section correspondante du [README](README.md) et le fichier
[.env.example](.env.example) pour les recommandations de configuration
(secret de session, clé de chiffrement des notifications, HTTPS, etc.).
Ne jamais exposer directement le port de PM2 Monitor sur Internet sans
authentification (`PM2_MONITOR_DISABLE_AUTH` doit rester désactivé) ni sans
reverse proxy HTTPS.
