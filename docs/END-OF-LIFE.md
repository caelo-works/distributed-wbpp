# Distributed WBPP: end of life

## End of life: Distributed WBPP is withdrawn

**Distributed WBPP is withdrawn, every version, by 2026-12-12.** It does not fit the rules
of the Certified PixInsight Developer Program, so it is no longer distributed, updated or
supported.

**Removing it from the CaeloWorks update repository does not uninstall it.** Copies
already installed stay on your PCs until you remove them. Follow the steps below on
**every PC** where you installed it, server and clients alike.

**Do not leave client mode running.** A PC in client mode accepts work from the network.
Version 1.0.0 in particular runs code received from the network (security advisory
[GHSA-r9w7-3wf4-hhr2](https://github.com/caelo-works/distributed-wbpp/security/advisories/GHSA-r9w7-3wf4-hhr2)):
stop it now.

### How to uninstall

`<PixInsight>` is the PixInsight installation folder, for example
`C:\Program Files\PixInsight` on Windows, `/Applications/PixInsight` on macOS (the folder
that contains `PixInsight.app`, `src` and `rsc`) or `/opt/PixInsight` on Linux.
`<home>` is your user folder: `C:\Users\<you>`, `/Users/<you>` or `/home/<you>`.

1. **Stop it.** On each client, click **Leave client mode**, close the script, then quit
   PixInsight. Check that no sidecar is left running: on Windows, end `wbpp-sidecar.exe`
   in the Task Manager (or run `taskkill /F /IM wbpp-sidecar.exe`); on macOS and Linux, run
   `pkill wbpp-sidecar`.
2. **Delete the script and its sidecar programs** from the PixInsight installation folder
   (administrator rights are needed):
   - `<PixInsight>/src/scripts/CaeloWorks/DistributedWBPP/` (the whole folder, including
     `bin/` and its `wbpp-sidecar-<os>-<cpu>` programs);
   - `<PixInsight>/rsc/icons/script/DistributedWBPP/`, if it exists (versions before 1.8.0);
   - versions 1.0.0 to 1.8.x only: the logs in `<PixInsight>/src/scripts/CaeloWorks/logs/`
     (`server-*.log`, `client-*.log`, `sidecar-*.log`), then that folder if it is empty.

   Keep `<PixInsight>/src/scripts/CaeloWorks/` itself if other CaeloWorks scripts are
   installed.
3. **Refresh the menu.** Start PixInsight, open **Script > Feature Scripts…**, click
   **Regenerate**, then **Done**, and restart PixInsight. **Script > CaeloWorks > Distributed WBPP** is
   gone.
4. **Delete the files in your user folder:**
   - `<home>/CaeloWorks/DistributedWBPP/` (logs and client cache, versions 1.9.x), then
     `<home>/CaeloWorks/` if it is empty;
   - in the system temporary folder, any leftover `wbpp-*` file or folder, and the
     `wbpp-cluster-worker` folder (versions 1.0.0 to 1.8.x).
5. **Delete the cluster key** (versions 1.9.x; earlier versions had none). It is stored in
   the PixInsight settings under `DistributedWBPP/clusterKey`. With a text editor, create a
   file named `remove-dwbpp-key.js` that contains this single line:

   ```
   Settings.remove( "DistributedWBPP/clusterKey" );
   ```

   In PixInsight, choose **Script > Execute Script File…**, select that file: it runs at
   once. Then delete the file. (In Windows Notepad, choose "All files" when saving, so the file
   is not named `remove-dwbpp-key.js.txt`.)
6. **Remove the firewall rule** for `wbpp-sidecar`, if you allowed it: on Windows, in
   **Windows Security > Firewall & network protection > Allow an app through firewall**; on
   macOS, in **System Settings > Network > Firewall > Options**.

The CaeloWorks update repository can stay in **Resources > Updates > Manage
Repositories** if you use other CaeloWorks scripts: it no longer offers Distributed WBPP,
but it does not remove it either.
