# Gionny — le QG

Une page de liens statique, animée et adaptée aux téléphones comme aux ordinateurs. Elle n’utilise ni framework ni service de suivi externe.

## Aperçu local

Depuis ce dossier, lance un serveur de fichiers statiques :

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000> dans ton navigateur.

## Modifier la page

- Les textes, destinations des liens et horaires se trouvent dans `index.html`.
- Les couleurs, animations et adaptations aux écrans se trouvent dans `styles.css`.
- `script.js` mémorise localement les réseaux déjà ouverts et fait suivre le halo du fond à la souris.
- Les polices Space Grotesk et Manrope sont servies depuis `assets/fonts/`, sans requête à un service externe. Leurs licences SIL Open Font License se trouvent dans le même dossier.
- L’icône de l’onglet est `favicon.svg`.

Les clics mémorisés restent dans le stockage du navigateur sur cet appareil; ils ne sont envoyés nulle part. Pour les effacer, il suffit de supprimer les données de ce site dans les paramètres du navigateur.

## Déploiement Vercel

Le site est servi directement depuis la racine du dépôt : aucune compilation ni installation n’est nécessaire. Dans Vercel, garde le dossier racine du dépôt et le préréglage **Other**, avec la commande de build vide. Les envois Git déclenchent des déploiements selon la branche de production configurée dans le projet.
