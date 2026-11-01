# Gionny — le QG

Une page de liens animée et adaptée aux téléphones comme aux ordinateurs. Les réseaux déjà ouverts sont mémorisés uniquement dans le navigateur.

## Aperçu local

Le site public peut être servi avec un serveur de fichiers statiques :

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000>. Le statut Twitch et la dernière vidéo YouTube passent par la fonction Vercel `/api/updates`; aucune clé ni connexion à un compte n’est requise. Les fonctions d’administration, elles, nécessitent les fonctions serveur Vercel et Vercel Blob.

## Modifier le site

- Les textes et la structure de la page se trouvent dans `index.html`.
- Les couleurs, animations et adaptations aux écrans se trouvent dans `styles.css`.
- `script.js` mémorise localement les réseaux déjà ouverts, lit les liens et le planning partagés, et actualise le ticker.
- `api/updates.mjs` lit les informations publiques de Twitch et YouTube via DecAPI, un service tiers sans clé ni connexion. Son fonctionnement peut dépendre de sa disponibilité et de son délai de mise à jour.
- `api/discord-status.mjs` récupère le nombre approximatif de membres en ligne depuis l’API publique des invitations Discord; le code est extrait du lien Discord enregistré et le compteur est actualisé environ toutes les 30 secondes.
- Les liens sociaux, les sous-titres facultatifs sous les pseudos et les horaires se modifient dans le panneau d’administration décrit ci-dessous.
- Les polices Space Grotesk et Manrope sont servies depuis `assets/fonts/`, sans requête à un service externe. Leurs licences SIL Open Font License se trouvent dans le même dossier.
- La photo fournie est rangée dans `assets/gionny-profile.jpg`. L’icône de l’onglet utilise cette même photo.

Les clics mémorisés et la dernière vidéo YouTube consultée restent dans le stockage de ce navigateur sur cet appareil; ils ne sont envoyés nulle part. Pour les effacer, supprime les données de ce site dans les paramètres du navigateur.

## Panneau d’administration

Le panneau n’a pas de lien dans la navigation du site. Après le déploiement, ouvre directement :

<https://qg2gionny.vercel.app/gestion-qg/>

Saisis le code d’accès à quatre caractères pour modifier les six liens sociaux, ajouter un petit sous-titre facultatif aux cinq profils, régler les horaires des lives et gérer les discussions reçues depuis le bouton « Écris-moi ». Une session reste ouverte jusqu’à huit heures, puis le code sera redemandé. Le serveur limite aussi les tentatives répétées; le code court reste toutefois moins sûr qu’un mot de passe long.

### Stockage partagé requis

Les variables `GIONNY_ADMIN_PIN` et `GIONNY_ADMIN_SESSION_SECRET` sont conservées dans les variables sensibles du projet Vercel; aucune valeur secrète n’est incluse dans les fichiers du site. Pour activer les sauvegardes visibles par tout le monde :

1. Dans le projet Vercel `qg2gionny`, crée un espace **Blob** dans l’onglet **Storage**.
2. Connecte cet espace au projet de production. Vercel y ajoute `BLOB_STORE_ID` et autorise les fonctions serveur avec OIDC; aucun jeton à copier dans le code n’est nécessaire.
3. Redéploie le site après la connexion du stockage si Vercel ne le fait pas automatiquement.
4. Retourne sur `/gestion-qg/`. Le bandeau indiquera que le stockage en ligne est actif; tu pourras alors enregistrer les changements.

Avant l’activation de Blob, le site garde les liens, sous-titres et horaires par défaut et le panneau ne permet pas de sauvegarder. Le fichier partagé contient seulement ces réglages publics, pas le code d’accès.

La bulle « M’écrire » ouvre une mini-discussion : le visiteur envoie un premier message, puis peut réduire et rouvrir le fil depuis le même navigateur pour lire tes réponses et continuer la conversation. Aucun e-mail, compte ou code à recopier n’est demandé. Un cookie privé et protégé relie le navigateur au fil; si la personne efface les cookies ou change d’appareil/navigateur, elle ne pourra pas récupérer cette discussion. Il n’y a pas de notification e-mail.

Les discussions et leurs messages sont conservés dans des objets **privés** Vercel Blob (préfixes `gionny/conversations/` et `gionny/conversation-messages/`). Ils ne sont pas accessibles publiquement : une session admin peut gérer tous les fils, tandis que le visiteur peut uniquement retrouver le sien grâce à son cookie privé. Dans le panneau, la liste des fils apparaît à gauche et le fil sélectionné à droite; tu peux répondre, fermer/réouvrir, bloquer ou supprimer une discussion. Le blocage empêche les réponses dans ce fil sur ce navigateur, mais ne vérifie pas l’identité réelle : sans compte ou e-mail, une personne peut contourner le blocage depuis un autre navigateur ou en effaçant ses cookies. L’inbox conserve aussi les anciens messages à sens unique (`gionny/inbox/`) : ils restent consultables/supprimables, mais ne peuvent pas être transformés en discussions.

Le formulaire limite la longueur des messages, ajoute un piège anti-robot et limite les envois répétés.

## Données Twitch et YouTube sans clés

Aucune clé Twitch/YouTube ni connexion à un compte n’est nécessaire. Le serveur appelle les endpoints publics DecAPI `/twitch/uptime/7gionny`, `/twitch/title/7gionny` et `/youtube/latest_video?handle=@Gionnyyy`. Quand Twitch confirme un direct, le compte à rebours du planning laisse place à « En direct actuellement » et le lecteur Twitch apparaît avec le son coupé par défaut; le paramètre `parent` reprend le nom d’hôte de la page. Si la hauteur d’écran ne suffit pas, le défilement vertical est réactivé pendant le direct pour ne pas couper le lecteur ni les réseaux. La vidéo YouTube reste simplement liée vers YouTube, elle n’est pas hébergée sur le site. Si une API publique est indisponible ou limite les requêtes, seul l’indicateur concerné reste masqué; le statut live n’est pas inventé.

Les nouveaux champs de sous-titres sont facultatifs et ajoutés au fichier de réglages partagé existant. Les configurations Blob déjà enregistrées sans ces champs restent valides : leurs liens et horaires ne sont pas remplacés.

## Déploiement Vercel

Le site est servi depuis la racine du dépôt. Dans Vercel, garde le dossier racine du dépôt et le préréglage **Other**, avec la commande de build vide. Le projet installe `@vercel/blob` pour les fonctions serveur. Les envois Git déclenchent les déploiements selon la branche de production configurée dans le projet.
