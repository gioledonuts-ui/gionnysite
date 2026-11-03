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

Il n’y a **aucun compte spécial** : le propriétaire est un membre comme les
autres, qui s’est vu attribuer le rôle « Hôte ».

1. Sur le site, « Créer un compte rapide » : ton pseudo (celui que tu veux) +
   ton mot de passe. Le compte est un compte membre normal.
2. Le panneau d’administration s’ouvre avec le **code à 4 caractères**
   (`GIONNY_ADMIN_PIN`) — il ne dépend d’aucun compte.
3. Onglet **Membres** → ton compte → **« Nommer Hôte »**.
4. C’est fini : ce compte est le propriétaire. Il garde son mot de passe, son
   pseudo, et ouvre le panneau avec le même code. Aucun autre compte ne peut
   être Hôte à la fois (nommer quelqu’un d’autre remplace l’ancien).

Points utiles :

- Le rôle est stocké dans `gionny/visitor-host.json` : il survit aux
  redémarrages et il suffit de recopier ce fichier pendant la bascule.
- Un compte Hôte ne peut être ni banni ni supprimé tant qu’il a le rôle
  (« Retirer Hôte » d’abord).
- Perte du mot de passe : seul le code du panneau peut te dépanner —
  connecte-toi avec le code, va dans Membres, et si besoin recrée un compte
  puis nomme-le Hôte.
