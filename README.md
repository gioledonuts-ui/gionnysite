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

La bulle « Écris-moi » ouvre une fenêtre floutée avec deux onglets : « Créer un compte » et « Se connecter ». Le compte demande un pseudo et un mot de passe d’au moins 8 caractères, sans e-mail. Une session privée reste active dans le navigateur pendant un an; en se reconnectant avec le même pseudo et le même mot de passe, la personne retrouve sa discussion sur un autre appareil. Il n’existe pas de récupération de mot de passe : le visiteur doit garder ces identifiants. Les anciennes discussions sont reliées au compte lors de l’inscription/connexion si l’ancien cookie du navigateur est encore présent et que le pseudo correspond.

Une nouvelle discussion demande un sujet (`Passer en live`, `Idée vidéo / React`, `Histoire / Anecdote`, `Question` ou `Discussion`). Les visiteurs peuvent envoyer du texte ou un vocal. L’enregistrement utilise `MediaRecorder` avec un débit cible de 24 kbit/s, s’arrête au bout d’une minute et refuse les fichiers de plus de 200 Ko. Cette limite est stricte; la taille réelle dépend du navigateur et du codec. Les vocaux sont stockés en privé et lus via une route protégée, jamais via une URL publique.

Les discussions, messages, comptes, sessions et vocaux sont conservés dans des objets **privés** Vercel Blob. Les anciens préfixes `gionny/conversations/` et `gionny/conversation-messages/` restent compatibles; les comptes/sessions et fichiers audio sont séparés (`gionny/visitor-accounts/`, `gionny/visitor-sessions/`, `gionny/conversation-audio/`). Une session admin peut gérer tous les fils; un visiteur ne peut lire que celui lié à sa session. Dans le panneau, la liste des fils apparaît à gauche et le fil sélectionné à droite; tu peux répondre, fermer/réouvrir, bloquer ou supprimer une discussion. L’inbox conserve aussi les anciens messages à sens unique (`gionny/inbox/`) : ils restent consultables/supprimables, mais ne peuvent pas être transformés automatiquement en discussions.

Le formulaire limite la longueur des messages, ajoute un piège anti-robot et limite les envois répétés. Le site statique utilise le script Web Analytics de Vercel (`/_vercel/insights/script.js`), pas le composant React/Next. Il faut activer **Web Analytics** dans le tableau de bord Vercel du projet pour commencer à recevoir les statistiques.

## Données Twitch et YouTube sans clés

Aucune clé Twitch/YouTube ni connexion à un compte n’est nécessaire. Le serveur appelle les endpoints publics DecAPI `/twitch/uptime/7gionny`, `/twitch/title/7gionny` et `/youtube/latest_video?handle=@Gionnyyy`. Quand Twitch confirme un direct, le compte à rebours du planning laisse place à « En direct actuellement » et le lecteur Twitch apparaît avec le son coupé par défaut; le paramètre `parent` reprend le nom d’hôte de la page. Si la hauteur d’écran ne suffit pas, le défilement vertical est réactivé pendant le direct pour ne pas couper le lecteur ni les réseaux. La vidéo YouTube reste simplement liée vers YouTube, elle n’est pas hébergée sur le site. Si une API publique est indisponible ou limite les requêtes, seul l’indicateur concerné reste masqué; le statut live n’est pas inventé.

Les nouveaux champs de sous-titres sont facultatifs et ajoutés au fichier de réglages partagé existant. Les configurations Blob déjà enregistrées sans ces champs restent valides : leurs liens et horaires ne sont pas remplacés.

## Déploiement Vercel

Le site est servi depuis la racine du dépôt. Dans Vercel, garde le dossier racine du dépôt et le préréglage **Other**, avec la commande de build vide. Le projet installe `@vercel/blob` pour les fonctions serveur et `@vercel/analytics` pour Web Analytics; le HTML statique charge directement le script Vercel sans importer de composant React/Next. Les envois Git déclenchent les déploiements selon la branche de production configurée dans le projet.
