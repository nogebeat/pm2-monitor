# PM2 Monitor — Règles communes

Tu travailles sur un **PM2 Monitor open source et self-hosted** existant.

## Avant de coder

Analyse uniquement les fichiers nécessaires à la phase demandée.

Réutilise l'architecture, les services, permissions, DB, WebSocket, tests et CI/CD déjà présents.

**Ne réécris pas l'existant et ne crée pas de système doublon.**

## Contraintes

- Ne casse aucune fonctionnalité existante.
- Code modulaire et maintenable.
- Pas de SaaS obligatoire.
- Pas de télémétrie/tracking.
- Aucun secret hardcodé.
- Respecte les permissions existantes.
- Privilégie les dépendances déjà présentes.
- N'ajoute une dépendance que si elle est réellement nécessaire.
- Compatible self-hosted.

## Tests

Ajoute les tests correspondant à la fonctionnalité.

Ne supprime aucun test existant.

Avant de terminer :

```text
tests → build → lint/typecheck si disponibles
```

Corrige les régressions avant de considérer la phase terminée.

## CI/CD

Intègre les nouveaux tests au CI/CD existant.

Si une migration est nécessaire, utilise le système de migrations existant.

Ne mets jamais de secrets dans le repository.

## Documentation

À la fin :

- mets à jour `README.md`
- mets à jour la documentation concernée
- documente uniquement les nouvelles configurations/API/permissions/migrations nécessaires

## Fin de phase

Réponds brièvement avec :

```text
Implémenté :
Fichiers modifiés :
Tests :
CI/CD :
Documentation :
Migration :
Sécurité :
Problèmes connus :

Tests: PASS/FAIL
Build: PASS/FAIL
Lint/Typecheck: PASS/FAIL
```

**Travaille uniquement sur la phase demandée. Ne commence pas la phase suivante.**
