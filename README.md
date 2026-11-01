# Gionny — le QG

Une page de liens animée et adaptée aux téléphones comme aux ordinateurs. Elle n’utilise ni framework ni outil de suivi des visites. Les réseaux déjà ouverts sont mémorisés uniquement dans le navigateur.

## Aperçu local

Depuis ce dossier, lance un serveur de fichiers statiques :

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000>. Le statut Twitch et la dernière vidéo YouTube passent par la fonction Vercel `/api/updates`; aucune clé ni connexion à un compte n’est requise.

## Modifier la page

- Les textes, destinations des liens et horaires se trouvent dans `index.html`.
- Les couleurs, animations et adaptations aux écrans se trouvent dans `styles.css`.
- `script.js` mémorise localement les réseaux déjà ouverts et l’identifiant de la dernière vidéo YouTube consultée.
- `api/updates.mjs` lit les informations publiques de Twitch et YouTube via DecAPI, un service tiers sans clé ni connexion. Son fonctionnement peut dépendre de sa disponibilité et de son délai de mise à jour.
- Les polices Space Grotesk et Manrope sont servies depuis `assets/fonts/`, sans requête à un service externe. Leurs licences SIL Open Font License se trouvent dans le même dossier.
- La photo fournie est rangée dans `assets/gionny-profile.jpg`. Pour ajouter une image de fond, dépose-la sous `assets/gionny-background.jpg`.
- L’icône de l’onglet utilise la photo fournie dans `assets/gionny-profile.jpg`.

Les clics mémorisés et la dernière vidéo YouTube consultée restent dans le stockage de ce navigateur sur cet appareil; ils ne sont envoyés nulle part. Pour les effacer, il suffit de supprimer les données de ce site dans les paramètres du navigateur.

## Données Twitch et YouTube sans clés

Aucune variable d’environnement Vercel ni connexion à un compte n’est nécessaire. Le serveur appelle les endpoints publics DecAPI `/twitch/uptime/7gionny`, `/twitch/title/7gionny` et `/youtube/latest_video?handle=@Gionnyyy`. La vidéo est simplement liée vers YouTube; elle n’est pas hébergée sur le site. Si DecAPI est indisponible ou limite les requêtes, l’état est laissé inconnu plutôt que d’afficher un faux direct.

## Déploiement Vercel

Le site est servi depuis la racine du dépôt : aucune compilation ni installation n’est nécessaire. Dans Vercel, garde le dossier racine du dépôt et le préréglage **Other**, avec la commande de build vide. Les envois Git déclenchent des déploiements selon la branche de production configurée dans le projet.
