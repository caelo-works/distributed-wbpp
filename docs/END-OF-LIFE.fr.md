# Distributed WBPP : fin de vie

## Fin de vie : Distributed WBPP est retiré

**Distributed WBPP est retiré, toutes versions, d'ici le 12 décembre 2026.** Il n'est pas
conforme aux règles du programme Certified PixInsight Developer : il n'est donc plus
distribué, ni mis à jour, ni pris en charge.

**Le retirer du dépôt de mises à jour CaeloWorks ne le désinstalle pas.** Les copies déjà
installées restent sur vos PC tant que vous ne les supprimez pas. Suivez les étapes
ci-dessous sur **chaque PC** où vous l'avez installé, serveur comme clients.

**Ne laissez pas le mode client tourner.** Un PC en mode client accepte du travail venu du
réseau. La version 1.0.0 en particulier exécute du code reçu du réseau (avis de sécurité
[GHSA-r9w7-3wf4-hhr2](https://github.com/caelo-works/distributed-wbpp/security/advisories/GHSA-r9w7-3wf4-hhr2)) :
arrêtez-la dès maintenant.

### Désinstallation

`<PixInsight>` est le dossier d'installation de PixInsight, par exemple
`C:\Program Files\PixInsight` sous Windows, `/Applications/PixInsight` sous macOS (le
dossier qui contient `PixInsight.app`, `src` et `rsc`) ou `/opt/PixInsight` sous Linux.
`<home>` est votre dossier utilisateur : `C:\Users\<vous>`, `/Users/<vous>` ou
`/home/<vous>`.

Les noms de menus et de boutons sont ceux de l'interface de PixInsight, en anglais.

1. **Arrêtez-le.** Sur chaque client, cliquez sur **Leave client mode**, fermez le script,
   puis quittez PixInsight. Vérifiez qu'aucun sidecar ne tourne encore : sous Windows,
   terminez `wbpp-sidecar.exe` dans le Gestionnaire des tâches (ou lancez
   `taskkill /F /IM wbpp-sidecar.exe`) ; sous macOS et Linux, lancez `pkill wbpp-sidecar`.
2. **Supprimez le script et ses programmes sidecar** du dossier d'installation de
   PixInsight (droits administrateur nécessaires) :
   - `<PixInsight>/src/scripts/CaeloWorks/DistributedWBPP/` (le dossier entier, y compris
     `bin/` et ses programmes `wbpp-sidecar-<os>-<cpu>`) ;
   - `<PixInsight>/rsc/icons/script/DistributedWBPP/`, s'il existe (versions antérieures à
     1.8.0) ;
   - versions 1.0.0 à 1.8.x uniquement : les journaux de
     `<PixInsight>/src/scripts/CaeloWorks/logs/` (`server-*.log`, `client-*.log`,
     `sidecar-*.log`), puis ce dossier s'il est vide.

   Gardez `<PixInsight>/src/scripts/CaeloWorks/` lui-même si d'autres scripts CaeloWorks
   sont installés.
3. **Rafraîchissez le menu.** Lancez PixInsight, ouvrez **Script > Feature Scripts…**,
   cliquez sur **Regenerate**, puis sur **Done**, et redémarrez PixInsight. L'entrée
   **Script > CaeloWorks > Distributed WBPP** a disparu.
4. **Supprimez les fichiers de votre dossier utilisateur :**
   - `<home>/CaeloWorks/DistributedWBPP/` (journaux et cache client, versions 1.9.x), puis
     `<home>/CaeloWorks/` s'il est vide ;
   - dans le dossier temporaire du système, tout fichier ou dossier `wbpp-*` restant, et le
     dossier `wbpp-cluster-worker` (versions 1.0.0 à 1.8.x).
5. **Supprimez la clé de cluster** (versions 1.9.x ; les versions antérieures n'en avaient
   pas). Elle est enregistrée dans les réglages de PixInsight sous
   `DistributedWBPP/clusterKey`. Avec un éditeur de texte, créez un fichier nommé
   `remove-dwbpp-key.js` qui contient cette seule ligne :

   ```
   Settings.remove( "DistributedWBPP/clusterKey" );
   ```

   Dans PixInsight, choisissez **Script > Execute Script File…**, sélectionnez ce fichier : il
   s'exécute aussitôt. Supprimez ensuite le fichier. (Dans le Bloc-notes de Windows, choisissez « Tous
   les fichiers » à l'enregistrement, pour que le fichier ne s'appelle pas
   `remove-dwbpp-key.js.txt`.)
6. **Supprimez la règle de pare-feu** de `wbpp-sidecar`, si vous l'aviez autorisé : sous
   Windows, dans **Sécurité Windows > Pare-feu et protection du réseau > Autoriser une
   application via le pare-feu** ; sous macOS, dans **Réglages Système > Réseau >
   Coupe-feu > Options**.

Le dépôt de mises à jour CaeloWorks peut rester dans **Resources > Updates > Manage
Repositories** si vous utilisez d'autres scripts CaeloWorks : il ne propose plus
Distributed WBPP, mais il ne le supprime pas non plus.
