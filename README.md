# Gionny — page de liens

Une page statique, légère et adaptée aux mobiles pour retrouver les réseaux de Gionny et son planning de lives. Elle n’utilise ni framework ni dépendance externe.

## Aperçu local

Depuis ce dossier, lance un petit serveur de fichiers statiques :

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000> dans ton navigateur.

## Modifier la page

- Les textes, destinations des liens et horaires se trouvent dans `index.html`.
- Les couleurs, espacements et adaptations téléphone/ordinateur se trouvent dans `styles.css`.
- L’icône de l’onglet est `favicon.svg`.

## Déploiement Vercel

Le site est servi directement depuis la racine du dépôt : aucun processus de compilation n’est nécessaire. Dans les paramètres du projet Vercel, garde le dossier racine du dépôt et le préréglage **Other** ; laisse la commande de build vide si elle est proposée. Une fois le dépôt relié à Vercel, les envois Git déclenchent des déploiements : la branche de production configurée dans Vercel met à jour le site public, tandis qu’une autre branche produit généralement une prévisualisation.
