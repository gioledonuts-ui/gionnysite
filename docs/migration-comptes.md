# Comptes, connexion et rôles

## 1. Authentification stricte (aucun passe-droit)

| Action | Ce qui se passe |
| --- | --- |
| **S’inscrire** | Crée le compte **uniquement si le pseudo est libre**, et enregistre le mot de passe (scrypt + sel, jamais en clair). Pseudo : 3 à 16 caractères. Mot de passe : 8 à 128 caractères. |
| **Se connecter** | Vérifie que le compte existe **et** que le mot de passe saisi correspond au hash enregistré. |

Messages renvoyés par `POST /api/contact` :

| Situation | Code | `error` |
| --- | --- | --- |
| Mot de passe faux | `401` | `Mot de passe incorrect.` |
| Pseudo inconnu | `404` | `Compte introuvable. Crée-le avec « S’inscrire ».` |
| Pseudo déjà pris à l’inscription | `409` | `Ce pseudo est déjà pris. Choisis-en un autre ou connecte-toi.` |
| Pseudo invalide | `400` | règle des 3 à 16 caractères |
| Mot de passe trop court | `400` | règle des 8 à 128 caractères |
| Compte banni | `403` | `Ce compte a été désactivé par l’administration.` |

**Plus aucun bypass** : `Gionny` ne s’ouvre plus avec le pseudo seul, et un clic
sur « Se connecter » ne crée plus de compte. Il n’y a plus de rate limit sur la
connexion (le mot de passe est la seule barrière).

### Le compte propriétaire `Gionny`

Le compte existe dès le départ (`role: "host"`, couronne, badge Validé) mais
**sans mot de passe** : il est donc fermé. Il est **réclamé une seule fois** par
une inscription avec le pseudo `Gionny` (ou `7gionny`, `@7gionny` — les trois
désignent le même compte) : le mot de passe choisi à ce moment-là devient le sien,
définitivement. Ensuite, seule cette combinaison ouvre le compte, avec les droits
admin.

> En cas de perte du mot de passe : le panneau `/gestion-qg/` (code à 4
> caractères `GIONNY_ADMIN_PIN`) permet de nommer un autre compte **Hôte**, donc
> de récupérer un accès administrateur sans jamais casser la règle du mot de passe.

## 2. Rôles : ajouter **et** retirer

Dans `MEMBRES` du panneau admin, deux interrupteurs indépendants :

- **Hôte** (couronne) — `Nommer Hôte` / `Retirer Hôte` (`PATCH {role}`).
- **Validé** (badge bleu) — `Donner Validé` / `Retirer Validé` (`PATCH {badges}`).

Cliquer une deuxième fois retire le rôle immédiatement. Le bouton affiche son
état (`is-on`) et `aria-pressed`. Le serveur relit le rôle enregistré à chaque
requête : retirer Hôte coupe l’accès admin tout de suite, et le compte perd la
couronne dans le même temps (`isAdmin` disparaît du profil renvoyé).

## 3. Stockage (RAM + /tmp, sans Vercel Blob)

Vercel Blob n’est **plus utilisé** (quota Hobby saturé) et le paquet est retiré
des dépendances.

- `globalThis.__qgState` (RAM de l’instance) contient tout : comptes, sessions,
  conversations, messages, vocaux, images, réglages du site.
- Chaque écriture dépose un snapshot dans `/tmp/qg-state.json` (`fs.writeFileSync`
  dans un `try/catch` : un disque qui refuse ne fait jamais échouer la requête).
- Au démarrage, l’instance relit le snapshot, sinon elle repart d’un état vide
  **avec le compte propriétaire déjà créé**.

## 4. Rien ne se perd (auto-sync navigateur)

Si `/tmp` est vidé par un redémarrage à froid, le navigateur renvoie le profil et
les derniers messages qu’il garde dans `localStorage` (`qg.member.sync.v1`) :

1. `POST /api/contact {action:"sync"}` rejoue les identifiants enregistrés — le
   mot de passe est vérifié comme n’importe quelle connexion ; si le compte a
   disparu, il est recréé à l’identique (mêmes identifiants, jamais un autre) ;
2. le fil existant est **ré-attaché** au lieu d’en créer un second ;
3. seuls les messages manquants sont ajoutés (aucun doublon).

## 5. Limite à connaître

`/tmp` est propre à chaque instance et n’est pas partagé entre deux instances
simultanées (ni garanti après un redéploiement). C’est le prix du 100 % gratuit :
en cas de trafic sur plusieurs instances, deux visiteurs peuvent voir deux états
différents tant que le navigateur n’a pas relancé sa synchro.
