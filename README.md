# Gionny — le QG

Une page de liens animée et adaptée aux téléphones comme aux ordinateurs. Elle n’utilise ni framework ni outil de suivi des visites. Les réseaux déjà ouverts sont mémorisés uniquement dans le navigateur.

## Aperçu local

Depuis ce dossier, lance un serveur de fichiers statiques :

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000>. Le site et ses liens restent utilisables sans les API. Pour afficher l’état Twitch réel et la dernière vidéo YouTube, le déploiement doit aussi disposer de la fonction Vercel `/api/updates` et de ses variables d’environnement.

## Modifier la page

- Les textes, destinations des liens et horaires se trouvent dans `index.html`.
- Les couleurs, animations et adaptations aux écrans se trouvent dans `styles.css`.
- `script.js` mémorise localement les réseaux déjà ouverts et actualise le bandeau depuis `/api/updates`.
- `api/updates.mjs` interroge Twitch et YouTube côté serveur : les secrets ne sont jamais envoyés au navigateur.
- Les polices Space Grotesk et Manrope sont servies depuis `assets/fonts/`, sans requête à un service externe. Leurs licences SIL Open Font License se trouvent dans le même dossier.
- L’icône de l’onglet est `favicon.svg`.

Les clics mémorisés restent dans le stockage du navigateur sur cet appareil; ils ne sont envoyés nulle part. Pour les effacer, il suffit de supprimer les données de ce site dans les paramètres du navigateur.

## Variables Vercel pour Twitch et YouTube

Dans le tableau de bord Vercel, ouvre le projet **gionnysite**, puis va dans **Settings → Environment Variables → Add New**. Ajoute ces variables et coche au minimum l’environnement **Production** :

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `YOUTUBE_API_KEY`

Enregistre les variables puis redéploie le projet pour les activer. Ne mets pas ces valeurs dans `index.html` ou `script.js` : garde-les dans les paramètres Vercel.

## Déploiement Vercel

Le site est servi depuis la racine du dépôt : aucune compilation ni installation n’est nécessaire. Dans Vercel, garde le dossier racine du dépôt et le préréglage **Other**, avec la commande de build vide. Les envois Git déclenchent des déploiements selon la branche de production configurée dans le projet.
