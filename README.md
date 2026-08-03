# PM2 Monitor

Interface graphique complète pour surveiller tes apps PM2 : liste des process,
statut, CPU/mémoire, redémarrages, et **logs en direct** (stdout/stderr) via WebSocket.

Ce n'est pas une page web statique : c'est un petit serveur Node.js à faire
tourner **sur la machine où PM2 gère déjà tes apps** (il se branche sur l'API
programmatique de PM2, comme le ferait `pm2 monit` en ligne de commande), avec
un frontend **Vue 3 + Vite** qui consomme cette API en REST + WebSocket.

## Stack technique

- **Backend** : Node.js, Express, `pm2` (API programmatique), Socket.IO.
- **Frontend** : Vue 3 (`<script setup>`), Vite, Chart.js, Socket.IO client.
  Le frontend est **compilé** (`npm run build`) en fichiers statiques servis
  directement par Express — il n'y a pas de serveur Node séparé à exposer
  en production, un seul port suffit.
- Aucune base de données : l'historique système et les logs persistés sont
  stockés en fichiers locaux (`data/`).

Structure du dépôt :

```
pm2-monitor/
├── server.js            # serveur Express + API REST + WebSocket + bus PM2
├── lib/                  # logique métier (actions PM2, stats système, logs, historique)
├── frontend/              # source du frontend Vue 3 + Vite
│   ├── src/
│   │   ├── components/    # TopBar, ProcessSidebar, LogsPanel, SystemView, modales…
│   │   ├── store.js       # état réactif partagé (process, logs, système)
│   │   ├── socket.js, api.js, format.js
│   │   └── style.css
│   └── vite.config.js
├── public/                # ⚠️ généré par `npm run build` — ne pas éditer à la main
└── deploy.sh
```

## Installation

### Option rapide : script de déploiement automatique

Sur un serveur Linux (Ubuntu/Debian ou CentOS/RHEL/Rocky/AlmaLinux), en root
ou avec sudo :

```bash
cd pm2-monitor
chmod +x deploy.sh
./deploy.sh install
```

Ce script gère **toutes les situations** en une commande :
- installe Node.js et PM2 s'ils sont absents (ne touche à rien s'ils sont déjà là)
- installe les dépendances du serveur **et** celles du frontend
- **compile le frontend Vue 3 / Vite** (`frontend/` → `public/`)
- génère un `.env` avec un mot de passe sécurisé si tu n'en fournis pas
- démarre l'app sous PM2 et configure le redémarrage automatique au reboot
- (optionnel) configure nginx en reverse proxy + HTTPS via Let's Encrypt si tu donnes un domaine
- (optionnel) ouvre les bons ports dans le pare-feu (`ufw`) si présent
- relançable sans risque : il détecte ce qui est déjà en place et **rebuild le frontend à chaque `update`**

**Exemples :**

```bash
# Accès direct par IP:port, sans nginx
./deploy.sh install --port 4200 --user admin --pass "mon-mot-de-passe"

# Avec nom de domaine + HTTPS automatique
./deploy.sh install --domain pm2.mondomaine.fr --email moi@mondomaine.fr

# Environnement minimal (conteneur, pas de pare-feu ni nginx à toucher)
./deploy.sh install --no-nginx --no-firewall --no-startup --yes
```

**Autres commandes :**

```bash
./deploy.sh status      # état du process PM2
./deploy.sh logs        # logs en direct
./deploy.sh restart     # redémarrer
./deploy.sh stop        # arrêter
./deploy.sh update      # git pull (si dépôt git) + npm install + build frontend + restart
./deploy.sh uninstall           # retire le process PM2
./deploy.sh uninstall --purge   # + supprime .env, node_modules (serveur + frontend), le build public/, config nginx
```

Voir toutes les options : `./deploy.sh --help`

### Option manuelle

```bash
cd pm2-monitor
npm install        # installe les deps serveur + déclenche l'install des deps frontend (postinstall)
npm run build       # compile le frontend Vue 3 / Vite dans public/
```

## Lancer le monitor

### Production (frontend compilé, un seul port)

```bash
npm run build   # si pas déjà fait
npm start
```

Puis ouvre **http://localhost:4200** (ou l'IP du serveur si tu y accèdes à distance).

Le port par défaut est `4200`, modifiable :

```bash
PORT=8080 npm start
```

### Développement (hot-reload frontend)

```bash
npm run dev
```

Ceci lance **en parallèle** le serveur Express (port `4200`, API + WebSocket)
et le serveur de dev Vite (port `5173`, hot-reload instantané des composants
Vue). Ouvre **http://localhost:5173** pendant que tu développes — Vite
proxifie automatiquement `/api` et `/socket.io` vers le port `4200`
(configuré dans `frontend/vite.config.js`).

Tu peux aussi lancer les deux séparément si tu préfères deux terminaux :

```bash
npm run dev:server   # terminal 1 — Express sur :4200
npm run dev:client   # terminal 2 — Vite sur :5173
```

> `public/` est un dossier **généré** par `npm run build` : ne modifie pas son
> contenu directement, tes changements seraient écrasés au prochain build.
> Tout le code source du frontend vit dans `frontend/`.

## Fonctionnalités

### Process

- **Liste des apps** : statut (online / stopped / errored…), CPU, mémoire,
  nombre de redémarrages, uptime, mode (fork/cluster), mini-graphique d'activité CPU.
- **Badge d'erreurs** : un compteur rouge apparaît sur les cartes des apps qui
  écrivent des erreurs pendant que tu regardes une autre app.
- **Actions rapides** : start / restart / reload / stop directement depuis chaque carte.
- **Actions étendues** (bouton "⋯ Plus" sur chaque carte) :
  - Scale (nombre d'instances, mode cluster)
  - Watch ON/OFF
  - Modifier les variables d'environnement (appliqué au redémarrage)
  - Modifier le script / les arguments / le mode fork↔cluster
  - Flush des logs de cette app
  - Réinitialiser le compteur de restarts
  - Supprimer le process
- **Actions globales PM2** (menu "PM2 ⋯" en haut à droite) :
  Sauvegarder (`pm2 save`), Resurrect, Flush tous les logs, Update PM2,
  Kill daemon PM2 (confirmation demandée).

### Vue Système (onglet "Système")

- Charge machine (load average 1/5/15 min), RAM, swap, disque, bande passante
  réseau (↓/↑ en temps réel), température CPU (Linux), nombre de processus système.
- **Historique CPU/RAM** avec sélecteur 1h / 6h / 24h (graphiques Chart.js),
  échantillonné toutes les 5s et persisté sur disque (survit aux redémarrages).
- Graphique d'historique réseau (Ko/s montant/descendant).
- Sur un OS non-Linux ou en environnement conteneurisé, certaines métriques
  (température, swap) peuvent être indisponibles (`n/d`) — c'est normal, pas
  tous les OS les exposent.

### Logs

- **Flux en direct** : filtre "Tout / stdout / stderr", filtre par niveau
  (info/warn/error/debug, détecté par heuristique sur le texte), recherche
  texte **ou regex**, coloration **ANSI**, numéros de ligne, auto-scroll,
  bouton **copier** par ligne, **pause du flux** (les lignes manquées sont
  comptées et rejouées à la reprise).
- **Recherche plein texte** dans l'historique complet du fichier (pas
  seulement ce qui a défilé à l'écran), avec filtre regex/niveau.
- **Aller à une date** : retrouve les lignes autour d'un horodatage précis.
- **Export** : logs bruts PM2 complets, ou **export d'une période précise**
  (date de début/fin) grâce à l'horodatage que le monitor ajoute à chaque ligne.
- **Persistance et compression automatique** : chaque ligne de log est
  enregistrée côté serveur (`data/logs/`) avec son timestamp ; les fichiers
  sont **rotés automatiquement au-delà de 5 Mo** puis **compressés en gzip**
  (réglable via `LOG_ROTATE_SIZE_MB` dans `.env`).

### Général

- **Interface Vue 3** entièrement componentisée (réactive, sans manipulation
  manuelle du DOM), polices `Space Grotesk` / `JetBrains Mono` auto-hébergées
  (aucune dépendance à un CDN de polices en production).
- **Thème clair / sombre** : bouton ◐ en haut à droite, préférence mémorisée.
- **Auth basique intégrée** : identifiant/mot de passe demandés par le
  navigateur (HTTP Basic Auth), sur les routes HTTP *et* la connexion WebSocket.
- **Stats globales** : nombre total d'apps, en ligne, arrêtées, état de la connexion.

### Limites connues

- La modification de **script / arguments / mode d'exécution** supprime puis
  relance le process (équivalent à `pm2 delete` + `pm2 start`) : c'est la
  seule façon fiable de le faire via l'API programmatique de PM2 (pas de
  "hot edit" natif pour ces champs).
- Le filtre par **niveau de log** (info/warn/error/debug) est une heuristique
  basée sur des mots-clés dans le texte (`error`, `warn`, `exception`…), pas
  une vraie extraction de niveau structuré — utile en pratique, mais pas
  garanti à 100 % selon le format de logs de ton app.

## Authentification

Par défaut, si tu ne configures rien, un mot de passe **aléatoire** est
généré à chaque démarrage et affiché dans la console — pratique pour tester,
mais il change à chaque redémarrage.

Pour un accès stable, copie `.env.example` en `.env` et renseigne :

```bash
cp .env.example .env
```

```
PORT=4200
PM2_MONITOR_USER=admin
PM2_MONITOR_PASS=un-mot-de-passe-solide
```

Pour désactiver l'auth (déconseillé sauf en local strictement) :
`PM2_MONITOR_DISABLE_AUTH=1`.

## Notes importantes

- Le serveur doit tourner **là où PM2 est installé et gère les process**
  (même machine, même utilisateur). Il ne se connecte pas à un PM2 distant.
- L'auth basique protège l'accès, mais le trafic n'est **pas chiffré** en HTTP
  simple : si tu exposes le dashboard au-delà de `localhost`, mets-le derrière
  un reverse proxy HTTPS (nginx + certificat) ou un VPN.
- Pour le faire tourner en continu, tu peux même le gérer... par PM2 :
  ```bash
  pm2 start server.js --name pm2-monitor
  ```
