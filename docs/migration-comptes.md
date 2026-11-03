# Garder les comptes lors d’un changement de Blob

Les profils, les conversations et le compte propriétaire vivent dans le Blob
Vercel (`gionny/...`). Un Blob supprimé ou remplacé **n’efface pas** les comptes
si on recopie ses fichiers avant : tout est dans une seule arborescence.

## 1. Ce qui doit être recopié

Tout ce qui commence par `gionny/` :

| Chemin | Contenu |
| --- | --- |
| `gionny/visitor-accounts/` | les comptes (pseudo, mot de passe haché + sel) |
| `gionny/visitor-sessions/` | les sessions ouvertes |
| `gionny/visitor-host.json` | le membre promu « Hôte » |
| `gionny/owner-recovery.json` | l’empreinte du code de récupération du propriétaire |
| `gionny/conversations/`, `gionny/conversation-messages/` | les discussions |
| `gionny/conversation-audio/`, `gionny/conversation-images/` | les pièces jointes |
| `gionny/site-config.json` | les réglages du site |

Aucun compte n’est stocké « dans le code » : le propriétaire est simplement le
compte dont le pseudo est réservé (`Gionny`, `7gionny`, `@7gionny`).

## 2. Recopier l’ancien Blob vers le nouveau

```bash
# une seule fois par environnement
npx vercel login          # ou VERCEL_TOKEN=... pour un agent
npx vercel link

# 1. sauvegarde locale de l’ancien store
OLD_STORE=<ancien-store-id>
NEW_STORE=<nouveau-store-id>
npx vercel blob list --store-id "$OLD_STORE" --prefix gionny/ --limit 1000 --json > backup-list.json

# 2. copie fichier par fichier dans le nouveau store
jq -r '.[].pathname' backup-list.json | while read -r path; do
  npx vercel blob get "$path" --store-id "$OLD_STORE" --access private --output "/tmp/blob-backup/$path" --yes
  npx vercel blob put "/tmp/blob-backup/$path" --store-id "$NEW_STORE" --access private \
    --pathname "$path" --allow-overwrite --yes
done
```

> Les comptes, sessions et récupérations sont des blobs **privés** : toujours
> `--access private`, sinon les hachages de mots de passe seraient publics.

## 3. Brancher le nouveau store sur le projet

1. Vercel → projet `qg2gionny` → **Storage** : connecter le nouveau Blob au
   projet (cela met à jour `BLOB_STORE_ID` / `BLOB_READ_WRITE_TOKEN`).
2. Vérifier dans **Settings → Environment Variables** que `BLOB_STORE_ID`
   pointe sur le nouveau store pour *Production*.
3. Redéployer (les variables d’environnement ne sont lues qu’au démarrage).

## 4. Vérifier après la bascule

```bash
curl -s https://qg2gionny.vercel.app/api/contact \
  -H 'content-type: application/json' -H 'origin: https://qg2gionny.vercel.app' \
  -d '{"action":"login","pseudo":"<un pseudo existant>","password":"<son mot de passe>"}'
```

- `200` + `"account"` → les comptes ont bien suivi.
- `401` `"Pseudo ou mot de passe incorrect."` → le compte n’est pas dans le
  nouveau store : reprendre l’étape 2 pour `gionny/visitor-accounts/`.

## 5. Compte propriétaire

Le compte `Gionny` n’est **jamais** accessible avec le seul pseudo.

- Il se protège avec **son** mot de passe (défini par
  `GIONNY_OWNER_PASSWORD`, ou par le formulaire de récupération).
- Le retour après une bascule passe par le **code de récupération** :
  16 caractères générés par le serveur, stockés hachés dans
  `gionny/owner-recovery.json`.

Procédure :

1. Vercel → Settings → Environment Variables → ajouter `GIONNY_OWNER_PASSWORD`
   (le mot de passe choisi, 8 caractères minimum), *Production*, puis redéployer.
2. Se connecter une fois avec le pseudo `Gionny` et ce mot de passe.
3. Ouvrir `/api/owner-recovery` avec `{ "action": "issue-code", "password": "…" }`
   depuis le site (bouton « Mot de passe oublié ? » → émettre le code), puis
   **conserver le code affiché** (format `XXXX-XXXX-XXXX-XXXX`).
4. En cas d’oubli : même bouton, saisir le code + un nouveau mot de passe.
5. Le code ne peut être changé que par son porteur : la route est limitée à
   5 essais / 15 minutes.
