# Stockage des comptes (RAM + /tmp, sans Vercel Blob)

Vercel Blob n'est **plus utilisé** : le plan Hobby était saturé et toutes les
requêtes échouaient, ce qui bloquait la connexion. Le site vit maintenant sur
un stockage autonome, gratuit et instantané.

## Comment ça marche

- `globalThis.__qgState` (RAM de l'instance) contient tout : comptes, sessions,
  conversations, messages, vocaux, images, réglages du site.
- Chaque écriture met aussi une photo de l'état dans `/tmp/qg-state.json`
  (`fs.writeFileSync` dans un `try/catch` : si le disque refuse, la requête
  n'échoue jamais, seul le snapshot est perdu).
- Au démarrage, une instance relit `/tmp/qg-state.json` si le fichier existe,
  sinon elle part d'un état vide **avec le compte propriétaire déjà créé**.
- Aucun appel à `@vercel/blob` ne reste dans le code (le paquet a été retiré des
  dépendances) : plus de quota, plus de 429, plus de route qui plante.

## Compte propriétaire

- Il existe d'office : pseudo `Gionny`, `isAdmin`, `isHost`, `verified`.
- Il s'ouvre avec **le pseudo seul** : `Gionny`, `7gionny`, `@7gionny`
  (casse et espaces ignorés) — aucune vérification de mot de passe.
- N'importe quel autre pseudo ouvre aussi : s'il n'existe pas, il est créé à la
  seconde avec le mot de passe saisi. Plus jamais « identifiants incorrects ».
- Le panneau `/gestion-qg/` garde son code à 4 caractères (`GIONNY_ADMIN_PIN`) :
  c'est **l'entrée du panneau**, indépendante du compte.

## Rien ne se perd (auto-sync navigateur)

Le serveur peut redémarrer à froid et vider `/tmp`. Dans ce cas :

1. le navigateur renvoie à `POST /api/contact {action:"sync"}` le profil et les
   derniers messages qu'il garde dans `localStorage` (clé `qg.member.sync.v1`) ;
2. le serveur recrée le compte si besoin, **ré-attache le fil existant** au lieu
   d'en créer un second, et n'ajoute que les messages manquants (pas de doublon) ;
3. si le compte a disparu mais que la conversation est encore là, elle est
   rattachée automatiquement à la reconnexion.

## Limite à connaître

`/tmp` est propre à chaque instance et n'est pas partagé entre deux instances
simultanées (ni garanti après un redéploiement). C'est le prix du 100 % gratuit :
en cas de trafic sur plusieurs instances, deux visiteurs peuvent voir deux états
différents tant que le navigateur n'a pas relancé sa synchro.
