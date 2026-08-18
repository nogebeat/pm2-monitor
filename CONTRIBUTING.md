# Contribuer à PM2 Monitor

Merci de vouloir contribuer 🎉 Ce document explique comment proposer un
correctif, une fonctionnalité, une traduction ou simplement signaler un bug.

Le projet et ses issues/PR peuvent être écrits **en français ou en anglais**,
au choix du contributeur — l'interface elle-même est désormais disponible
dans les deux langues (voir [Traductions](#traductions--i18n) plus bas).

---

## Table des matières

- [Code de conduite](#code-de-conduite)
- [Avant de commencer](#avant-de-commencer)
- [Mise en place de l'environnement](#mise-en-place-de-lenvironnement)
- [Lancer le projet en développement](#lancer-le-projet-en-développement)
- [Lancer les tests](#lancer-les-tests)
- [Style de code](#style-de-code)
- [Traductions / i18n](#traductions--i18n)
- [Soumettre une Pull Request](#soumettre-une-pull-request)
- [Signaler un bug](#signaler-un-bug)
- [Proposer une fonctionnalité](#proposer-une-fonctionnalité)
- [Sécurité](#sécurité)

---

## Code de conduite

Ce projet adhère au [Contributor Covenant](CODE_OF_CONDUCT.md). En
participant, tu acceptes de le respecter. Merci d'être bienveillant·e et
respectueux·se envers les autres contributeur·rice·s.

## Avant de commencer

- Vérifie qu'une [issue](../../issues) ou une
  [pull request](../../pulls) similaire n'existe pas déjà.
- Pour un changement important (nouvelle fonctionnalité, refonte
  d'architecture), ouvre d'abord une issue pour en discuter avant de coder —
  ça évite du travail perdu si l'approche ne convient pas.
- Pour une correction de bug simple ou une typo, tu peux directement ouvrir
  une pull request.

## Mise en place de l'environnement

Prérequis : **Node.js ≥ 20** et PM2 déjà installé/en fonctionnement sur ta
machine de développement (`npm install -g pm2`).

```bash
git clone https://github.com/<ton-fork>/pm2-monitor.git
cd pm2-monitor
npm install            # installe aussi les dépendances du frontend (postinstall)
cp .env.example .env   # adapte les valeurs si besoin
```

## Lancer le projet en développement

```bash
npm run dev
```

Cette commande démarre en parallèle :

- le serveur Express (`npm run dev:server`) sur le port défini dans `.env`
  (4200 par défaut) ;
- le serveur de dev Vite du frontend (`npm run dev:client`) avec hot-reload.

Pour ne lancer que l'un des deux, utilise `npm run dev:server` ou
`npm run dev:client` séparément.

## Lancer les tests

```bash
npm test               # tous les tests (unit + intégration)
npm run test:unit
npm run test:integration
```

Les tests utilisent le test runner natif de Node.js (`node --test`), aucune
dépendance de test supplémentaire n'est nécessaire.

Merci d'ajouter ou de mettre à jour les tests correspondant à ton
changement — une PR sans test pour une nouvelle fonctionnalité ou un bugfix
sera probablement plus longue à relire et à merger.

## Style de code

- **Backend** : JavaScript standard (CommonJS/ESM cohérent avec le fichier
  modifié), pas de framework de style imposé mais reste cohérent avec le
  code existant du dossier (`lib/`, `bin/`, `test/`).
- **Frontend** : Vue 3 avec `<script setup>`, composants sous
  `frontend/src/components/`. Garde les composants petits et centrés sur
  une responsabilité, comme le reste du projet.
- Pas de linter/formatter automatique configuré à ce jour — merci de rester
  cohérent avec l'indentation et les conventions du fichier que tu modifies.
- Les commentaires de code existants sont majoritairement en français ;
  tu peux commenter en français ou en anglais, l'important est la clarté.

## Traductions / i18n

L'interface est disponible en **français** et **anglais** via `vue-i18n`.
Les fichiers de traduction se trouvent dans :

```
frontend/src/i18n/locales/fr.json   # langue source
frontend/src/i18n/locales/en.json
```

Pour ajouter une nouvelle chaîne :

1. Ajoute la clé dans `fr.json` **et** `en.json` (les deux fichiers doivent
   rester synchronisés — mêmes clés dans le même ordre autant que possible).
2. Utilise `t("namespace.cle")` dans le template, ou `t("namespace.cle", { variable })`
   pour les chaînes avec interpolation (voir les fichiers existants pour
   des exemples de convention de nommage des clés).
3. Ne mets jamais de texte affiché à l'utilisateur en dur dans un composant
   `.vue` — passe toujours par `t(...)`.

Ajouter une **nouvelle langue** est bienvenu (ouvre une issue pour en
discuter d'abord) : il suffira d'ajouter un fichier `locales/<code>.json`
et de l'enregistrer dans `frontend/src/i18n/index.js`.

## Soumettre une Pull Request

1. Fork le dépôt et crée une branche depuis `main` :
   `git checkout -b feat/ma-fonctionnalite` (ou `fix/mon-correctif`).
2. Fais des commits atomiques avec des messages clairs. Le préfixage façon
   [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`,
   `fix:`, `docs:`, `chore:`…) est apprécié mais pas obligatoire.
3. Assure-toi que `npm test` et `npm run build` passent sans erreur.
4. Ouvre la Pull Request contre `main` avec :
   - un résumé clair du **quoi** et du **pourquoi** ;
   - un lien vers l'issue concernée s'il y en a une (`Closes #123`) ;
   - des captures d'écran/GIF pour tout changement d'UI.
5. La CI (GitHub Actions) doit passer au vert avant relecture.
6. Reste disponible pour les échanges de relecture — un mainteneur peut
   demander des ajustements avant de merger.

## Signaler un bug

Utilise le [template d'issue "Bug report"](.github/ISSUE_TEMPLATE/bug_report.md).
Plus le rapport est précis (étapes de reproduction, comportement attendu vs
observé, version de Node/PM2/OS, logs pertinents), plus vite il pourra être
corrigé.

⚠️ Ne colle jamais de secret (mot de passe, token, clé de chiffrement) dans
une issue publique.

## Proposer une fonctionnalité

Utilise le [template d'issue "Feature request"](.github/ISSUE_TEMPLATE/feature_request.md)
pour décrire le besoin, le cas d'usage concret, et — si tu en as une —
la solution envisagée.

## Sécurité

Pour toute vulnérabilité de sécurité, **ne pas** ouvrir d'issue publique.
Suis la procédure décrite dans [SECURITY.md](SECURITY.md).

---

Merci encore pour ta contribution ! 🙏
