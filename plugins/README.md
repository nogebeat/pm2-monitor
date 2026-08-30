# plugins/

Ce dossier est scanné au démarrage de PM2 Monitor (voir
[`lib/services/plugins/loader.js`](../lib/services/plugins/loader.js)).
Chaque sous-dossier contenant un `index.js` est chargé comme un plugin.

**Documentation complète : [`docs/plugins/README.md`](../docs/plugins/README.md).**

## Ajouter un plugin

1. Créez un dossier `plugins/mon-plugin/`.
2. Ajoutez un `index.js` qui exporte :

```js
module.exports = {
  name: "mon-plugin", // doit correspondre au nom du dossier
  version: "1.0.0",
  pluginApiVersion: "1.0.0",
  description: "…",
  async init(context) {
    // votre code
  },
};
```

3. Redémarrez PM2 Monitor. Le plugin apparaît dans Settings → Plugins.

## Sécurité

Un plugin est du code exécuté sur le serveur, avec les mêmes privilèges
que PM2 Monitor lui-même. **N'installez jamais un plugin dont vous ne
connaissez/maîtrisez pas le code.** PM2 Monitor ne télécharge ni n'exécute
jamais automatiquement un plugin — vous seul(e) décidez de ce qui se
trouve dans ce dossier.

Voir [`docs/plugins/README.md`](../docs/plugins/README.md) pour le détail.

## `hello-world/`

Plugin de démonstration livré avec le projet, pour valider que l'API
fonctionne. Il n'est pas requis — vous pouvez le désactiver ou supprimer
son dossier sans impact sur le reste du monitor.
