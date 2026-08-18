# Changelog

Toutes les modifications notables de ce projet seront documentées ici.

Le format suit les principes de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/),
et ce projet adhère au [Semantic Versioning](https://semver.org/lang/fr/).

## [Non publié]

### Ajouté

- 🌐 Internationalisation (i18n) complète de l'interface avec support
  **français / anglais** via `vue-i18n`, sélecteur de langue dans la barre
  du haut, détection automatique de la langue du navigateur, préférence
  persistée en local.
- Fichiers de gouvernance open source : `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`, `LICENSE` (MIT).
- Templates GitHub : rapport de bug, demande de fonctionnalité, template de
  Pull Request.
- Workflow CI (GitHub Actions) : tests unitaires + intégration sur Node 20
  et 22, build du frontend, vérification de parité des clés de traduction.
- Script `scripts/check-i18n.js` (`npm run check:i18n`) pour vérifier que
  les fichiers `fr.json` et `en.json` restent synchronisés.
- Outillage qualité : ESLint (backend + frontend), Prettier, EditorConfig,
  `.gitattributes`, `.nvmrc`.
- Hygiène Git : hooks Husky (`pre-commit` → lint-staged, `commit-msg` →
  commitlint / Conventional Commits), `.github/CODEOWNERS`.
- CI étendue avec un job `lint` dédié (ESLint + Prettier + parité i18n) en
  plus des tests et du build.

### Corrigé

- `package.json` : le champ `version` n'était pas un semver valide
  (`3.5.f`) — corrigé en `3.5.0`.
- `npm run test:unit` / `test:integration` utilisaient un pattern de glob
  non supporté par le test runner de Node et plantaient immédiatement
  (`Cannot find module 'test/unit'`) — corrigé.
- Suite de tests validée à 576/576 (unitaires + intégration, exécutés
  ensemble comme en CI) après réinstallation propre des dépendances.
- `npm test` / `test:unit` / `test:integration` s'appuyaient sur le
  support du glob `**` ou du chemin de répertoire nu par
  `node --test`, tous deux non fiables selon la version de Node et l'OS
  (confirmé en échec sur GitHub Actions avec Node 22.23.2 avec l'un et
  l'autre). Remplacé par `scripts/run-tests.js`, qui énumère les fichiers
  `*.test.js` à la main en JS pur avant de les passer explicitement à
  `node --test` — comportement documenté et stable.

## Format des entrées futures

Chaque nouvelle version doit lister ses changements sous les catégories :
`Ajouté`, `Modifié`, `Déprécié`, `Supprimé`, `Corrigé`, `Sécurité`.
