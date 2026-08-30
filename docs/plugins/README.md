# Plugin System

Phase 21 du projet : une architecture minimale et stable permettant à des
contributeurs d'étendre PM2 Monitor **sans modifier le core**. Un plugin est
un dossier de code déposé manuellement dans [`plugins/`](../../plugins/) à
la racine du repo, jamais installé automatiquement.

## Sommaire

- [Architecture](#architecture)
- [Contrat d'un plugin](#contrat-dun-plugin)
- [Le context](#le-context)
- [Cycle de vie](#cycle-de-vie)
- [Registry](#registry)
- [Sécurité](#sécurité)
- [Configuration](#configuration)
- [API REST](#api-rest)
- [Permissions](#permissions)
- [Interface](#interface)
- [Compatibility](#compatibility)
- [Créer un plugin](#créer-un-plugin)
- [Exemple](#exemple)
- [Migration](#migration)
- [Tests](#tests)
- [Types de plugins à venir](#types-de-plugins-à-venir)
- [Limites connues](#limites-connues)

## Architecture

```
plugins/                                 # code des plugins (hors du core, voir Sécurité)
├── README.md
└── hello-world/                         # plugin de démonstration interne
    └── index.js

lib/services/plugins/
├── api-version.js       # PLUGIN_API_VERSION + isCompatible()
├── validate.js           # validation structurelle du contrat d'un plugin
├── registry.js            # PluginRegistry : register/get/list/has (en mémoire, pur)
├── store.js                 # persistance DB : activé/désactivé + config (table `plugins`)
├── context.js                 # construit le `context` restreint passé à init()/onDisable()
├── loader.js                    # découvre/require() plugins/<nom>/index.js
└── index.js                        # orchestrateur : loadAll/list/enable/disable/updateConfig

lib/routes/plugins.js                   # routeur Express (/api/plugins/…)
lib/db/migrations/022_plugins.js       # table `plugins` (état activé/désactivé + config)
```

Chaque module a une seule responsabilité, même découpage que
[`docs/service-dependencies/README.md`](../service-dependencies/README.md) :
`loader.js` ne connaît jamais la DB, `store.js` ne connaît jamais le
filesystem, `registry.js` ne connaît ni l'un ni l'autre. `lib/services/
plugins/index.js` est le SEUL point d'entrée utilisé par `lib/routes/
plugins.js` et `server.js`.

## Contrat d'un plugin

Un plugin est un module Node qui exporte :

```js
module.exports = {
  name: "mon-plugin",              // string — DOIT correspondre au nom du dossier
  version: "1.0.0",                // string — version du plugin lui-même
  pluginApiVersion: "1.0.0",       // string — version de l'API PM2 Monitor visée
  description: "…",                // string, optionnel
  async init(context) { … },       // requis — appelé à l'activation
  async onDisable(context) { … },  // optionnel — appelé à la désactivation
};
```

Contrat volontairement minimal (voir [Types de plugins à
venir](#types-de-plugins-à-venir)) : pas de notion de "type" de plugin pour
l'instant, juste un point d'entrée générique. Validé par
[`validate.js`](../../lib/services/plugins/validate.js).

## Le context

`init(context)` / `onDisable(context)` reçoivent une API **restreinte**
(voir [`context.js`](../../lib/services/plugins/context.js)) :

| Clé | Description |
| --- | --- |
| `context.logger.info/warn/error(...)` | Logs préfixés `[plugin:<nom>]` |
| `context.config.get()` | Retourne la config **propre à ce plugin** (persistée) |
| `context.config.set(obj)` | Remplace la config de ce plugin (JSON-sérialisable) |
| `context.meta.name` / `context.meta.version` | Identité du plugin lui-même |

**Jamais exposé** : la DB brute (`lib/db`), le filesystem arbitraire, les
secrets (clés de chiffrement, tokens, `.env`), le process Node
(`process.exit`, `child_process`, `require` arbitraire). Ce n'est pas une
sandbox — voir [Sécurité](#sécurité).

## Cycle de vie

1. **Découverte** (au démarrage uniquement, voir `server.js`) :
   `loader.js` scanne `plugins/`, `require()` chaque `index.js` trouvé.
2. **Enregistrement** : `registry.js` valide la forme du plugin
   (`validate.js`) et l'unicité du nom → statut `invalid` si échec.
3. **Compatibilité** : `pluginApiVersion` du plugin comparé à
   `PLUGIN_API_VERSION` courant → statut `incompatible` si le MAJOR diffère
   (voir [Compatibility](#compatibility)).
4. **Activation** (si compatible et activé en base — activé par défaut à la
   première découverte) : `init(context)` est appelé, isolé par
   `try/catch` → statut `active` ou `error`.
5. **Enable/Disable** (à chaud, via l'API/l'UI) : appelle `init()` /
   `onDisable()` une seule fois chacun ; ne re-scanne jamais le disque.

Ajouter un **nouveau** dossier sous `plugins/` nécessite un redémarrage du
process (le scan disque n'a lieu qu'au boot) — volontaire, pour éviter un
double-`init()` d'un plugin déjà actif.

## Registry

[`registry.js`](../../lib/services/plugins/registry.js) expose :
`register(plugin)`, `unregister(name)`, `get(name)`, `has(name)`,
`list()`, `clear()`. Purement en mémoire, ne connaît ni la DB ni le
filesystem — testable indépendamment (voir [Tests](#tests)).

## Sécurité

**Un plugin est du code exécuté sur le serveur, avec les mêmes privilèges
que PM2 Monitor lui-même.** Ce n'est PAS une sandbox : Node ne permet pas
d'isoler nativement du code tiers sans un processus séparé, hors scope de
cette phase. Le `context` restreint limite ce qu'un plugin **bien
intentionné** fait facilement (pas de raccourci vers la DB brute par
exemple), mais n'empêche pas un plugin malveillant d'utiliser directement
`require("fs")`, `require("child_process")`, etc. — un plugin reste du
code Node comme un autre.

Règles strictes, appliquées par le code (pas seulement documentées) :

- **Aucune route d'installation** : `lib/routes/plugins.js` n'expose que
  liste/détail/enable/disable/config — jamais d'upload ni de téléchargement
  de code. Un plugin s'ajoute **uniquement** en déposant un dossier sur le
  serveur (accès filesystem/SSH, hors de portée de l'API HTTP).
- **`loader.js` ne télécharge jamais rien** : il ne fait que `require()`
  du code déjà présent sur disque.
- **N'installez jamais un plugin dont vous ne maîtrisez pas le code.**

## Configuration

Chaque plugin a sa propre configuration (objet JSON libre, jamais
interprétée par le core), persistée dans la table `plugins` (colonne
`config`). Un plugin y accède via `context.config.get()`/`set()` —
scoping strict par nom, un plugin ne peut jamais lire/modifier la config
d'un autre plugin.

Les **secrets** (clés API d'un service tiers, tokens…) qu'un plugin
voudrait stocker doivent utiliser les mécanismes déjà existants du
monitor (variables d'environnement lues directement par le plugin, jamais
stockées en clair dans `config` — la colonne `config` n'est PAS chiffrée,
contrairement aux secrets des providers de notification, voir
[`docs/notifications/README.md`](../notifications/README.md)).

## API REST

Toutes les routes sont sous `/api/plugins`.

| Méthode | Route | Permission | Description |
| --- | --- | --- | --- |
| GET | `/` | `plugins_read` | Liste tous les plugins découverts |
| GET | `/:name` | `plugins_read` | Détail d'un plugin |
| POST | `/:name/enable` | `plugins_manage` | Active un plugin (appelle `init()`) |
| POST | `/:name/disable` | `plugins_manage` | Désactive un plugin (appelle `onDisable()` si fourni) |
| PUT | `/:name/config` | `plugins_manage` | Remplace la configuration d'un plugin |

Champs d'une entrée (`GET /` et `GET /:name`) :

```json
{
  "name": "hello-world",
  "version": "1.0.0",
  "pluginApiVersion": "1.0.0",
  "description": "…",
  "status": "active",
  "error": null,
  "enabled": true,
  "compatible": true,
  "hasOnDisable": true,
  "config": {},
  "installedAt": 1730000000000,
  "updatedAt": 1730000000000
}
```

`status` : `active` | `disabled` | `error` | `invalid` | `incompatible`.

## Permissions

Deux permissions globales (voir [`lib/permissions.js`](../../lib/permissions.js)) :

- `plugins_read` : voir la liste, le statut, la version et la configuration.
- `plugins_manage` : activer/désactiver un plugin, modifier sa configuration.

Le rôle prédéfini `auditor` a `plugins_read` (comme `servers_read`/
`dependencies_read`/`reports_read`). Aucun rôle prédéfini n'a
`plugins_manage` en dehors d'`admin` — un plugin exécutant du code
arbitraire, sa gestion reste une action sensible.

Chaque activation/désactivation/changement de configuration est tracé dans
l'audit log (`PLUGIN_CHANGE`, voir
[`docs/audit/README.md`](../audit/README.md)), succès **et** échec.

## Interface

Settings → Plugins (bouton 🧩 dans la TopBar, visible avec `plugins_read`) :
liste des plugins avec statut/version/description, boutons Activer/
Désactiver et Configuration (édition JSON) réservés à `plugins_manage`.

## Compatibility

`PLUGIN_API_VERSION` (actuellement `"1.0.0"`, voir
[`api-version.js`](../../lib/services/plugins/api-version.js)) suit une
règle de compatibilité MAJOR uniquement : un plugin déclarant
`pluginApiVersion: "1.x.x"` est compatible avec `PLUGIN_API_VERSION` 1.x —
un changement mineur/patch de l'API plugin (ex: une nouvelle clé ajoutée
à `context`) reste rétro-compatible ; un changement MAJOR (ex: une clé de
`context` retirée) ne l'est pas. Un plugin incompatible est visible dans
l'UI (statut `incompatible`) mais ne peut jamais être activé — `init()`
n'est jamais appelé pour lui.

## Créer un plugin

Voir [`plugins/README.md`](../../plugins/README.md) pour le guide pas à
pas. En résumé : créer `plugins/mon-plugin/index.js` exportant le
[contrat](#contrat-dun-plugin), redémarrer PM2 Monitor.

## Exemple

[`plugins/hello-world/`](../../plugins/hello-world/index.js) est un plugin
de démonstration livré avec le projet, qui valide l'API de bout en bout
(découverte, `init()`, `context.logger`, `context.config.get/set`
persistée, `onDisable()`). Il n'est **pas** une dépendance obligatoire :
le désactiver ou supprimer son dossier n'affecte aucune fonctionnalité du
core.

## Migration

`022_plugins` (additive) — table `plugins` : `name` (unique), `enabled`,
`config` (JSON texte), `installed_at`, `updated_at`. Ne stocke jamais le
code d'un plugin, uniquement son état administratif (voir
[Architecture](#architecture)).

## Tests

- `test/unit/plugins-validate.test.js` — validation structurelle du contrat.
- `test/unit/plugins-registry.test.js` — register/get/list/has/duplicate.
- `test/unit/plugins-store.test.js` — persistance activé/désactivé/config.
- `test/unit/plugins-index.test.js` — `loadAll()` : chargement, plugin
  invalide, plugin incompatible, isolation d'un `init()` qui plante,
  activation/désactivation.
- `test/integration/plugins-api.test.js` — routes REST + permissions.

## Types de plugins à venir

Prévus, non développés dans cette phase (voir prompt de phase — "commence
par une API minimale et stable") : notification providers, health checks,
metrics, actions, dashboard widgets, exporters, integrations. Ces types
étendront le contrat actuel (probablement un champ `type` + des points
d'entrée additionnels) sans casser un plugin `init()`-only existant.

## Limites connues

- Pas de sandbox réelle (voir [Sécurité](#sécurité)) — un plugin a les
  mêmes privilèges que le process PM2 Monitor.
- Un nouveau dossier sous `plugins/` nécessite un redémarrage (pas de
  hot-reload de code) — seuls enable/disable/config sont à chaud.
- Pas de gestion de dépendances entre plugins (ordre de chargement =
  ordre alphabétique du scan disque).
- La configuration d'un plugin n'est jamais chiffrée (voir
  [Configuration](#configuration)).
