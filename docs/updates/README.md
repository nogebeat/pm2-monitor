# Mises à jour — version, release disponible, diagnostic (Phase 23, étape 1)

Ajoute au dashboard un bouton **⬆ Mises à jour** (barre du haut) qui répond à
trois questions :

1. **Quelle version est installée ?**
2. **Une release plus récente est-elle publiée ?** (avec ses notes de version)
3. **Cette installation peut-elle se mettre à jour avec `./deploy.sh update` ?**
   (diagnostic) — et, si oui, **la commande exacte à lancer** sur le serveur,
   avec un bouton « Copier ».

Une pastille apparaît sur le bouton dès qu'une version plus récente existe.

> **Strictement en lecture seule.** Cette interface **n'exécute aucune mise à
> jour** : ni bouton « Mettre à jour », ni exécution de `git`, `npm` ou `pm2`
> pour modifier quoi que ce soit. Elle informe et indique la commande. Un test
> automatisé (`test/integration/updates-api.test.js`) vérifie qu'aucune route
> autre que la revérification n'existe, et un autre
> (`test/integration/updates-diagnostics.test.js`) que seules des commandes
> `git` d'inspection sont lancées.

## Pourquoi pas un bouton qui met à jour ?

Parce que PM2 Monitor est installé par n'importe qui, n'importe comment (clone
git, archive, conteneur, utilisateur non-root, dossier en lecture seule…), et
qu'un bouton qui réécrit le code de l'application depuis l'application elle-même
cumule trois risques : des environnements impossibles à tous couvrir, un
compromis du dashboard qui devient permanent (le service doit pouvoir réécrire
son propre code), et l'outil de diagnostic qui disparaît si la mise à jour
échoue. L'étape 1 apporte l'essentiel de la valeur — savoir qu'il y a une
mise à jour, et si l'installation peut la faire — sans ces risques.

## Comment la vérification fonctionne

- Source : les **releases GitHub** du dépôt (`GET /repos/{owner}/{repo}/releases`).
  Seuls les tags **stables `vMAJOR.MINOR.PATCH`** comptent : brouillons,
  pré-versions et tags d'une autre forme (`v4.2`, `v4.2.0-rc1`, `nightly`…)
  sont ignorés.
- Jusqu'à **5 versions plus récentes** sont listées (la plus récente d'abord)
  avec leurs notes, pour qu'une installation en retard voie tout ce qu'elle
  saute. Chaque version est typée **correctif / mineure / majeure** ; une
  majeure affiche un avertissement (changements possiblement incompatibles).
- Une vérification toutes les **6 h** (`UPDATE_CHECK_INTERVAL_MS`, minimum 1 h),
  la première peu après le démarrage. Le résultat est mis en cache dans
  `data/update-check.json` : un redémarrage — ou une boucle de crash — ne
  ré-interroge pas GitHub tant que le cache est frais. L'ETag est réutilisé
  (une réponse `304` ne coûte rien de la limite de 60 requêtes/heure/IP de
  l'API non authentifiée).
- Après une erreur (réseau, limite de débit…), nouvelle tentative au plus tôt
  **30 min** plus tard — ou à l'heure de réinitialisation annoncée par GitHub.
- **« Revérifier »** force une vérification, **au plus une par minute**.

### Confidentialité

L'unique appel sortant est une requête `GET` vers l'API GitHub. Elle **n'envoie
aucune donnée de l'installation** : le `User-Agent` est générique
(`pm2-monitor-update-check`), sans version ni nom d'hôte, et aucun cookie ni
jeton n'est transmis. Pour ne faire **aucun appel sortant** (serveur isolé,
politique réseau) : `UPDATE_CHECK_ENABLED=0` — l'interface l'indique, et le
reste fonctionne normalement.

### Contenu distant non fiable

Les notes viennent de GitHub : elles sont affichées en **texte brut** (jamais
interprétées comme du HTML), la réponse est plafonnée à 2 Mo, chaque note à
3 000 caractères, et seuls des liens `http(s)` sont conservés.

## Diagnostic de l'installation

Le diagnostic reflète le comportement **réel** de `deploy.sh update` : il tire
la branche courante avec `git pull --ff-only`, et met de côté les modifications
locales avec `git stash`.

| Contrôle                  | Bloquant ?                                          | Détail                                                                                                                                                                                                                   |
| ------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Type d'installation       | **oui** si conteneur ou pas de dépôt git            | `deploy.sh update` suppose un clone git.                                                                                                                                                                                 |
| Version de Node.js        | **oui** si inférieure à `engines.node`              |                                                                                                                                                                                                                          |
| Gestionnaire de processus | avertissement                                       | Non lancé par PM2 : `deploy.sh` redémarre l'app via PM2.                                                                                                                                                                 |
| Utilisateur du service    | avertissement si `root`                             | Une faille du dashboard donnerait les droits root.                                                                                                                                                                       |
| Base de données           | info                                                | `sqlite` ou `mysql` (la sauvegarde ne s'y fait pas pareil).                                                                                                                                                              |
| Droits d'écriture         | **oui**                                             | Le service doit pouvoir écrire dans son dossier.                                                                                                                                                                         |
| Espace disque libre       | avertissement < 500 Mo, **bloquant** < 100 Mo       |                                                                                                                                                                                                                          |
| Script `deploy.sh`        | **oui** si absent ; avertissement si non exécutable | Non exécutable : la commande proposée utilise `bash deploy.sh`.                                                                                                                                                          |
| `git` installé            | **oui**                                             |                                                                                                                                                                                                                          |
| Branche suivie            | **oui** si HEAD détaché ; avertissement hors `main` | `git pull` échoue en HEAD détaché.                                                                                                                                                                                       |
| Branche amont             | **oui** si absente                                  | Sans elle, `git pull` échoue.                                                                                                                                                                                            |
| Modifications locales     | avertissement                                       | `deploy.sh` met de côté (`git stash`) les fichiers **suivis** modifiés avant la mise à jour : seuls ceux-là comptent (pas les fichiers non suivis comme `data/`). Le dossier `public/` (généré par le build) est ignoré. |
| Dépôt d'origine           | avertissement si différent du dépôt suivi           | Typiquement un fork.                                                                                                                                                                                                     |

`canSelfUpdate` vaut `true` quand **aucun** contrôle n'est bloquant.

Garde-fous du diagnostic lui-même : uniquement des commandes `git`
d'inspection (`--version`, `rev-parse`, `describe`, `status`, `remote
get-url`), arguments fixes, **jamais de shell** (`execFile`), délai de 5 s,
`--no-optional-locks` (même `git status` n'écrit pas dans le dépôt). L'URL du
remote est **nettoyée de tout identifiant** (jeton, mot de passe) avant d'être
renvoyée, et le chemin d'installation est échappé pour la commande copiée.

## Permission et API

Nouvelle action globale **`updates_read`**, accordée à l'**admin** par défaut et
absente des rôles `operator` / `viewer` / `auditor` : le diagnostic révèle le
chemin d'installation, la branche suivie et l'utilisateur système du service.
Elle n'est pas dans les scopes de clés API (réservée à un humain connecté).

| Méthode | Route                      | Rôle                                                                                                               |
| ------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET`   | `/api/updates/status`      | Version installée, release disponible, versions en attente (avec notes), dernière vérification, erreur éventuelle. |
| `POST`  | `/api/updates/check`       | Force une vérification (limitée à 1/min, `throttled: true` sinon).                                                 |
| `GET`   | `/api/updates/diagnostics` | Diagnostic d'installation + commande à lancer (`?refresh=1` pour recalculer ; mis en cache 60 s).                  |

## Configuration

| Variable                   | Défaut                   | Rôle                                                                                                                            |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `UPDATE_CHECK_ENABLED`     | `1`                      | `0` : aucun appel sortant, l'interface l'indique.                                                                               |
| `UPDATE_CHECK_INTERVAL_MS` | `21600000` (6 h)         | Intervalle de vérification (minimum 1 h).                                                                                       |
| `UPDATE_CHECK_REPO`        | `nogebeat/pm2-monitor`   | Dépôt `propriétaire/nom` à interroger (un fork qui publie ses propres releases). Toute valeur mal formée retombe sur le défaut. |
| `UPDATE_CHECK_API_URL`     | `https://api.github.com` | Base de l'API (GitHub Enterprise Server, miroir interne).                                                                       |

## Limites connues

- **`deploy.sh update` tire la branche, pas un tag précis.** Il récupère le
  dernier commit de la branche suivie, qui peut contenir des changements pas
  encore publiés dans une release. L'interface le dit explicitement.
- **`deploy.sh` ne sauvegarde pas la base avant de migrer** et ne l'annule pas en
  cas de retour arrière : l'interface rappelle de la sauvegarder soi-même
  (copie de `data/monitor.db`, ou dump MySQL/MariaDB).
- La compatibilité avec la version de **Node requise par la release cible** n'est
  pas vérifiée (seule la version courante l'est) : lisez les notes.
- Les **agents distants** (`bin/agent.js`) ne sont pas concernés : ils se mettent
  à jour à part.
- Une installation en **conteneur** ou sans dépôt git est détectée comme non
  gérée : l'interface l'indique et explique la marche à suivre, sans proposer de
  commande.
