# Minecraft Server UI

A local Minecraft server panel inspired by the navigation and console layout of Apollo. Available as a Windows desktop app or a browser-based development server. Built with React, TypeScript, Vite, and an Express API, with Electron for the desktop app. Development work is on the `dev` branch.

## Windows desktop app

**MC Panel runs in its own Windows window and includes its Node.js runtime.** End users do not need to install Node.js, use a terminal, or start a separate web server. Running a real Minecraft server still requires the Java version expected by its server software. Configure the Java executable and startup settings, and accept the Minecraft EULA yourself. Install MC Panel on the computer hosting Minecraft. You can also connect from another desktop app to that host's remote panel; the host still runs Minecraft and manages its Java process.

A fresh desktop workspace starts with **Welcome to MC Panel**, where you can **Create a new server**, **Import an existing server**, or **Recover a saved server** previously removed from this panel. No server is registered until you confirm its setup.

The Windows x64 build produces two executables in `release/`:

| File                                    | Use                                            |
| --------------------------------------- | ---------------------------------------------- |
| `MC-Panel-0.1.3-dev.0-Setup-x64.exe`    | Install MC Panel, then launch it from Windows. |
| `MC-Panel-0.1.3-dev.0-Portable-x64.exe` | Run MC Panel without installing it.            |

The version in each filename follows `package.json`. These development builds are unsigned, so Windows may report an unknown publisher or show a SmartScreen notice. A code-signing certificate is not configured.

Closing the window keeps MC Panel in the Windows notification area so running servers and backup schedules can continue. Reopen it from its tray icon. Choose **Quit MC Panel** in the tray menu to exit completely; when Java servers are running, the app asks before stopping them and shutting down. Quit waits for active backups and file changes to finish before stopping Java. Servers and schedules run only while the app is running. Saved Java servers stay stopped after you reopen the app until you choose **Start**. Right-click the tray icon for **Open server data folder**, **Open downloads folder**, and **Help and documentation**.

### Connect to another panel

Open the account menu at the bottom of the sidebar and choose **Sign in to another panel**. Enter the other panel's HTTPS address, then choose **Continue to sign in**. If you have an invitation, choose **Accept an invitation** and paste the complete link. The welcome screen also has this account menu, so you can connect without creating a local server or installing Java on the connecting computer.

The desktop app switches to the remote panel inside the same window. The **Server selector** keeps local servers under **This computer** and each signed-in remote panel's servers under its address. These groups stay visible when you switch between local and remote servers. Select any server to open it directly while keeping the other connections signed in. Signing out, losing access, or disconnecting removes that panel's servers from the selector. The account menu also lets you switch panels or disconnect any saved panel, including an offline host. The remote sign-in screen provides **Back to this computer**. The browser edition opens connections in the current tab. Sign in with the account that host invited; accepting an invitation creates access and lets you choose a password. Accounts belong to the hosting panel. There is no public registration or universal MC Panel account. The local administrator entry identifies access to this computer and is not a remote account.

For a self-signed certificate, the desktop app displays the destination and certificate's SHA-256 fingerprint. Compare it with the fingerprint supplied by the owner through a trusted channel before choosing **Fingerprint matches — connect**. Cancel is the default. The app remembers that exact certificate for the connection across restarts. A changed certificate requires confirmation again; expired certificates and certificates for a different address are rejected. Browser connections use the browser's certificate handling.

The remote account menu shows your email and panel address and provides **Sign out** and **Disconnect from this panel**. Each desktop connection has an isolated saved session. Quitting and reopening the app restores your connections and keeps you signed in while the host's session remains valid. **Sign out** ends your login; **Disconnect from this panel** also forgets the connection and clears its saved session. Expired sessions or access revoked by the host require signing in again. Switching or disconnecting leaves Minecraft servers running on their host PCs. The host must keep MC Panel running with remote access enabled and reachable. Remote users use the same panel layout and pages as the desktop, with a responsive sidebar on phones. Available pages and actions follow their assigned permissions; connecting from the desktop does not grant local owner access. Update both the host and connecting desktop app to receive the latest interface.

### Desktop data

Both the installed and portable editions save the server registry, panel settings, backups, and newly created server files under:

```text
%APPDATA%\MC Panel\data
```

This is separate from the repository's `data/` directory, so the desktop app does not automatically import an existing development workspace. The portable executable uses the same per-user data location; it does not keep worlds beside the executable. App upgrades and uninstalling the app preserve this data. Use **Open server data folder** to find it, and retain your own backups before moving or removing server files. Existing custom Minecraft directories remain in their configured locations. Desktop startup and shutdown errors are recorded one level above this folder in `%APPDATA%\MC Panel\desktop.log`.

To remove a server from the panel, stop it, open its **Settings**, choose **Remove server**, review the name, and confirm removal. Removal stops its backup schedule and preserves its Minecraft files, worlds, backups, and Recycle Bin data on disk. Imported files remain in their original folder. Removing the last server returns to the welcome screen; it stays empty after restarting the app. For a managed server, choose **Recover a saved server** on the welcome screen or under **Add server**, review its startup settings, and explicitly confirm recovery. Recovery preserves its original ID, files, backups, and Recycle Bin and leaves it stopped. External server folders can be imported again. Recovery never automatically registers saved folders.

Desktop sidebar, Launchpad view, and player pagination choices survive app restarts independently of saved remote sign-ins. If quitting or applying an update takes too long, the app offers **Keep waiting**, **Open logs**, or an explicit **Exit now** choice. A timer never automatically kills Minecraft while it is saving. If the selected-server preference cannot be saved, the native dialog lets you cancel or continue without that preference.

### Create a new server

Choose **Create a new server**, then choose **Server software** or **Modpack**. Browse server software and choose a Minecraft version and build, or browse modpacks and select a release. Catalog browsing works before your first server exists.

Choose an actual build from the **Select build** placeholder, then give the server a name and choose its memory in GB. The **Java executable** dropdown shows one short entry per compatible major version, such as **JAVA 21**, using the newest verified installation for that major. Missing or incompatible installations are excluded. On supported Windows PCs, **Install Java** downloads the required Eclipse Temurin runtime when none is installed, verifies its published checksum and executable, and selects it automatically. These runtimes stay in MC Panel's private data folder and do not need administrator access or change your system PATH. Download progress and retry are available in setup; **Refresh Java** also finds runtimes installed elsewhere. The server port is available in **Advanced settings**. Setup checks Java again before you review the selected software or modpack, memory, and installation details. Accept the Minecraft EULA explicitly, then choose **Create and install**. The panel creates a separate server folder and shows installation progress. **Open Console** selects the new server; Minecraft stays stopped until you choose **Start**.

Cancelling before **Create and install** leaves no server or server files behind. If installation fails, **Retry installation** continues setup for the same server instead of creating another one. Modpacks with a supported runtime install that runtime as part of setup; unavailable files and unsupported combinations are reported for review.

To use software you installed yourself, choose **Import an existing server** and select its folder. New server creation installs the selected software or modpack and configures its Java startup command.

### Import an existing server

Choose **Import an existing server**, then browse to the folder containing its `server.properties`, startup files, and world. The desktop edition opens a native folder picker; you can also enter an absolute folder path. In browser mode, the path refers to the computer running the panel API. If your server is on another Windows PC, install MC Panel there and select its existing server folder. To move the server to a different computer instead, first stop it and copy the complete server folder to the destination.

The panel detects the server port, MOTD, player limit, world folder, EULA status, top-level JAR files, and supported NeoForge startup configuration. Review the name and startup method. For a JAR server, select the JAR used to start it; if there are multiple JARs, choose one explicitly. Java and memory settings are available for review. Stop any separately running copy before starting it through MC Panel.

Import registers the existing folder **in place**. It does not copy, move, overwrite, or start the server, and it preserves the existing EULA decision. Worlds, plugins, and configuration stay in the selected folder. File Manager and Console subsequently operate on that folder; backups, recycled files, and panel metadata go under `data/instances/<server-id>/`. Any port override is applied when you next start the server through the panel. Resetting MC Panel's app data removes the registration, panel backups, and Recycle Bin contents, but leaves files still in that external server folder intact.

Startup is configurable for different Minecraft Java distributions and modpacks: **Server JAR**, **Java arguments**, **Startup script**, or **Custom executable**. Standard Windows Forge, NeoForge, Fabric, and other simple Java launch scripts are detected when possible. For custom packs, select their script or enter the executable and its arguments; each argument gets its own line, preserving spaces without shell quoting. Windows supports `.bat`, `.cmd`, and `.ps1`; `.sh` requires a Unix shell. Scripts must keep the server in the foreground without detached windows or automatic restart loops so the panel can track and stop it. After a requested stop, the panel releases a Windows batch launcher's trailing **Press any key to continue** prompt so it can exit normally. OS-specific launchers still need their required runtime and libraries.

An import source must be separate from panel storage and other registered server folders. If its folder or required startup files become unavailable, the panel keeps the server listed with an actionable error instead of creating an empty replacement. Restoring the original files lets subsequent server requests reconnect it.

### Import NeoForge and an existing world

NeoForge's standard server installation uses `run.bat`, `user_jvm_args.txt`, and an argument file under `libraries/net/neoforged/neoforge/`; it does not require a root-level `server.jar`. See the [official NeoForge server guide](https://docs.neoforged.net/user/docs/server/).

1. Install MC Panel on the Windows computer holding your NeoForge server. Stop the server's existing console before starting it through the panel.
2. Choose **Add server → Import an existing server** and select the entire server folder containing `run.bat` and `server.properties`, rather than the world folder alone.
3. Choose **Inspect folder**. The panel recognizes standard NeoForge startup, reads the world name from `level-name` in `server.properties`, and lets you review the Java executable. No server JAR is needed.
4. Import the server, then use **Console → Start**. The existing `mods`, `config`, world, and player data stay in place. Keep the same Minecraft, NeoForge, and mod versions used by that world.

For a recognized NeoForge script, MC Panel reads its Java command and starts Java directly so console input, stop, and restart work. It preserves the NeoForge argument files and JVM options; configure NeoForge's memory in `user_jvm_args.txt` through File Manager while the server is stopped. This detected Java mode skips the batch wrapper and final `pause`. If a launcher cannot be translated, the panel offers its script as an explicit startup choice with foreground requirements. Import itself never starts Minecraft or accepts the EULA. After updating a modpack's startup command, inspect/import again or update the saved Java arguments to match; the panel preserves the arguments reviewed at import.

If your world is a separate save, stop the server, back up the existing server and save, and copy the **whole save folder** (including `level.dat`, `region`, and any mod data) inside the NeoForge server folder under an unused name. Set `level-name` in `server.properties` to that folder name before starting. The importer registers an existing server folder; it does not transfer a separate save or convert a world between server types.

### Build the Windows app from source

On Windows, install **Node.js 24 or newer** and **pnpm 11.19.0** (pinned in `package.json`), then run from the repository:

```sh
pnpm install --frozen-lockfile
pnpm desktop
```

`pnpm desktop` builds the frontend and opens the desktop app. Other build commands are:

```sh
pnpm desktop:pack
pnpm desktop:dist
```

`desktop:pack` creates an unpacked Windows app under `release/win-unpacked/`. Keep the entire directory together when running its executable. `desktop:dist` builds the installer and portable executable listed above. These commands prepare the Electron runtime automatically. Generated executables and packaging output stay in `release/` and are not committed to Git.

After `desktop:pack` or `desktop:dist`, run `pnpm test:desktop` to smoke-test the packaged app. It uses an isolated temporary workspace so it does not change your normal desktop server data.

Run `node desktop/remote-panels.smoke.mjs` to check remote connections with the installed Electron runtime. This uses a hidden test window, a temporary profile, and loopback HTTPS fixtures to verify certificate confirmation, session isolation, same-window switching, distinct local and remote server icons, and that disconnecting preserves the local panel.

Run `node desktop/remote-persistence.smoke.mjs` to verify saved connections and sign-ins across actual Electron process restarts. It uses a temporary profile and loopback HTTPS fixtures to check restoration, certificate trust, session isolation, sign-out, and disconnect behavior.

The [Windows desktop workflow](.github/workflows/windows-desktop.yml) runs on pushes to `dev` and can also be started manually. It builds both executables, runs backend and desktop unit tests, browser tests, and the packaged-app smoke test. A successful current `dev` build publishes a GitHub prerelease with a unique version, such as `0.1.3-dev.12.1`, the installer, portable copy, and updater metadata. Other branches produce workflow artifacts only. Incomplete builds remain unpublished, superseded commits are skipped, and older reruns cannot replace a newer dev update. Workflow artifacts expire after 14 days; published releases remain available.

### Update MC Panel

Install the **Setup** edition once on the server PC to enable updates. Earlier builds do not have an updater, so installing this first updater-enabled build is the one-time bootstrap. Future updates use **Updates → Check for updates → Download update → Restart to update**. The app also checks in the background after launch and every four hours, but never downloads, installs, or stops a server without an update action.

**Updates** stays available when the desktop app is connected to another PC. It opens the update dialog under **This computer**, keeping the remote connection available in the server selector. This updates the app on the computer you are using; update the other PC from its own desktop app.

Desktop connections use the interface bundled with the app on the computer you are using, including console search, level filters, clear view, and log downloads. Switching to a PC running an older interface therefore keeps the same controls and layout. Sign-in, server data, commands, and permissions still belong to the connected PC, and each host keeps its own isolated session. New features that require a newer server API still require updating the server PC. Browser connections use the interface served by their host.

Updates download from this repository's published dev releases and are checked against the release manifest's SHA-512 checksum by `electron-updater`. No GitHub login or token is bundled into the app. These development builds are unsigned; checksum verification is not a publisher signature. Portable/unpacked copies explain that the Setup edition is required rather than launching an installer over themselves.

Downloading leaves servers running. Applying an update asks before stopping running servers, waits for active backups and writes, then waits for graceful server exit before replacing the app. It preserves `%APPDATA%\MC Panel` and imported server folders. MC Panel reopens after installation with servers stopped; start them when ready. An offline network, failed download, or unavailable dev release can be retried from the same dialog. Updates change MC Panel only; they do not update Minecraft, Java, NeoForge, or mods.

## Run from source in a browser

Install **Node.js 24 or newer**, then:

```sh
npm install
npm run dev
```

The repository also includes a pnpm lockfile. With pnpm installed, use `pnpm install --frozen-lockfile` and `pnpm dev` for the locked dependency versions.

Open **http://127.0.0.1:5173**. Vite forwards API requests to the local backend on port 3001. A fresh workspace opens the welcome screen so you can create or import your first server. Existing registered servers and legacy workspaces are preserved.

For a compiled build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. `npm run preview` previews only the built frontend; use `npm start` for the complete application.

## What works

The **Server**, **Minecraft**, and **Management** sidebar headings collapse and reopen their sections. Each choice is remembered in this browser.

- **Multiple servers:** create independent Java servers, switch between them, and rename them. Each server has its own console, files, backups, schedule, access records, in-game operators, and audit logs. Servers can run concurrently on distinct ports.
- **Console:** start, stop, restart, timestamped output, command entry, resource charts, and server status. While a server is stopping, **Stop** becomes **Force Stop**. If shutdown hangs, confirm Force Stop to terminate that server's process and cancel any pending restart. This can lose unsaved progress or damage world files; normal Stop still waits for Minecraft to save. Start becomes available after the process has exited. Turn on **Server messaging** beside Autoscroll to broadcast text to all players without typing `say`; command and message drafts/history stay separate. Commands go directly to the server process's standard input, never to an operating system shell.
- **Players:** view Online Players, Banned Players, Operators, and Whitelist together, with Player History below. Each list starts with five players per page and has previous/next controls plus a choice of 5, 10, 25, 50, 75, or 100 rows. Row counts are saved independently in this browser; longer lists scroll within their panel. Actions beside names let you grant/remove OP, kick, ban/unban, or add/remove whitelist entries. The whitelist toggle enables or disables restricted joining. Player actions send Minecraft commands to the running server; check Console for the result. Rosters and the whitelist toggle read `ops.json`, `banned-players.json`, `whitelist.json`, and `server.properties`, so they can lag behind a command. History persists observed joins/leaves and includes saved profiles with Minecraft heads. Saved profiles may never have joined, and cache expiry is never presented as a login date.
- **File Manager:** browse folders, create files and directories, edit text files up to 1 MB, and upload/download original files. The top breadcrumb follows the open folder; click any parent folder or **File Manager** to go back. Deletion moves files or whole folders to a protected, per-server **Recycle Bin** outside the Minecraft folder. Restore returns an item to its original path and refuses to overwrite anything already there. Items remain until restored or explicitly deleted permanently; there is no automatic expiry. Row checkboxes support bulk moves, restores, and permanent deletion. Select-all affects visible rows without moving the checkbox, confirmations name selected recovery items, and failed actions stay selected for retry. Upload up to 20 files per request, 256 MB per file. Existing names are protected from accidental upload overwrites. Paths and symbolic links are checked to keep operations inside the configured server directory.
- **Backups:** create and download real `.tar.gz` archives with maximum gzip compression; configure interval, daily, or weekly schedules and retention. Each row shows the compressed size and, when recorded, the space saved. Existing archives are not recompressed. Files that are already compressed may shrink little further. Select individual archives or **Select all**, then use **Delete selected** to move them to Recycle Bin. Each row also has download and delete buttons. Restoring a backup from Recycle Bin returns the archive to backup history without extracting it or changing server files. Failed moves remain selected for retry. Manual backups are kept until deleted. Retention moves excess scheduled backups to Recycle Bin after a new archive succeeds; recycled archives continue using disk space until explicitly deleted permanently. Symbolic links and Minecraft's temporary `session.lock` files are excluded.
- **Subusers:** share a private invitation link to an authenticated panel on their phone or browser. Choose per-server Control, User, Files, Backups, and Audit permissions, or use the Control preset for console and power controls. Permission changes apply to active sessions immediately; removing a subuser revokes their access to that server. Direct access uses your public IP, a forwarded TCP port, and built-in HTTPS; no domain or email service is required. Recipients choose a password when accepting their invitation. Existing role records keep their equivalent permissions but require an invitation before remote access is granted.
- **Audit Logs:** server starts, restarts, stops, icons, API-key settings (without secret values), and explicit EULA acceptance appear under **Server**. File edits, directory deletions, and mod/plugin/datapack additions, updates, restores, and deletions appear under **Files**. **Players** contains operator, ban, kick, and whitelist actions; commands are recorded as requests sent to Minecraft. Backups and Subusers have their own categories. Scheduled actions identify **Scheduler**, while observed exits identify **Server process**; user actions default to **Local administrator**. Installation failures and scheduled backup retention are recorded too. The most recent 2,000 events are retained per server. Panel history keeps setup and server-removal events available after a server is removed. The table refreshes every ten seconds while visible, retains rows during manual refresh, and supports search and pagination.

## Manage multiple servers

The sidebar's first category, **Server Selector**, lists each server individually with its software and known Minecraft version. Select a server to switch workspaces, open **Settings**, or choose **Add server** to create or import another server. **Start**, **Restart**, and **Stop** stay at the top of the sidebar and control the selected server from any page. On small screens, use **Open navigation** to reach them. Guided creation browses software or modpacks, reviews name and memory, and installs only after confirmation. Give each server a unique Minecraft port (1024–65535) and its own Java heap allocation. The panel creates a separate server directory for every new server. Use **Import an existing server** for custom startup commands and software installed outside the panel.

The server's **display name** can change while it runs. Its **server list message (MOTD)** is a separate setting, shown in Minecraft's multiplayer server list. Stop a server before changing its MOTD, port, Java executable, JAR, or memory allocation. The selected port is written to `server.properties` when settings change and checked again at launch. Renaming alone does not change the MOTD.

Switching servers does not stop them or pause their backup schedules. Files and permissions always belong to the server selected when the operation was started. In-game OP access belongs in **Players**; **Subusers** grants panel access and does not grant in-game OP status. Console permission allows Minecraft commands, including operator commands.

The desktop app remembers the selected server across restarts and app updates in its own data folder, restoring that selection before loading server pages. If the saved server was removed, it selects a remaining registry entry. Browser sessions keep their selection in local browser storage.

## Configure an existing Java server

For a new server, use **Add server** in the **SERVER SELECTOR** sidebar category as described above. To import an existing server directory into a fresh panel installation:

1. Copy `.env.example` to `.env` before the first startup.
2. Set `MC_SERVER_DIR` to your existing Minecraft server directory, and `MC_SERVER_JAR` to the JAR filename inside that directory. Set `JAVA_PATH` if Java is not available on your PATH. Use the Java version required by your chosen server JAR.
3. Read and accept the [Minecraft EULA](https://aka.ms/MinecraftEULA) yourself, then set `eula=true` in the server's `eula.txt`.
4. Set `MC_MEMORY_MB` and the optional server display settings, then start the panel and use **Start**.

The first fleet startup imports the original default server's configuration and existing files, backups, schedules, and access records without moving or deleting them. The registry is saved in `data/servers.json`. After that, edit server settings in the panel: changing `MC_*` or `JAVA_PATH` in `.env` does not override saved server settings. `PORT` and `PANEL_DATA_DIR` still configure the API process. Environment settings for the original server are never implicitly applied to newly created servers.

Example configuration:

```dotenv
MC_SERVER_DIR=C:/Minecraft/survival
MC_SERVER_JAR=paper.jar
JAVA_PATH=C:/Program Files/Java/jdk-21/bin/java.exe
MC_MEMORY_MB=4096
MC_PORT=25565
MC_SERVER_NAME="Survival Server"
MC_SERVER_ADDRESS=localhost:25565
MC_SOFTWARE=Paper
MC_VERSION=1.21.4
```

The panel owns the Java process it launches. It cannot attach to an already running server. Desktop Quit and Restart to update send `stop` and wait for Minecraft to finish saving. If shutdown takes too long, the app offers Keep waiting, Open logs, or an explicit Exit now choice. Software and content are installed in your server only after you select and confirm an installation during guided creation, Versions, or Launchpad. Catalog browsing and modpack previews can download release metadata and modpack archives before confirmation to prepare the review. Your EULA choice is preserved. Use the **Import an existing server** interface for NeoForge startup detection; the legacy environment example above configures a JAR server.

Console output, commands, power state, uptime, disk usage, operator commands, and online-player tracking come from the server process. The online-player list follows recognized vanilla/Paper join and leave messages from the Java process launched by the panel. UUID authentication announcements supply player UUIDs when available. Tracking starts with that process and clears on stop, exit, and restart; it does not read old logs or attach to a separate running server. Plugins or server versions that replace these standard log messages may prevent complete tracking. This is log tracking, not a server query, and no player latency is invented.

The Console and Players pages fetch Minecraft head images in the browser from [MCHeads](https://mc-heads.net/), using the player's UUID when available and their username otherwise. No API key is needed. If an image cannot load, the panel shows its local default head.

CPU and memory readings cover the server process and its descendants. Windows uses [CIM process counters](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process), Linux uses `/proc`, and macOS uses `ps`. CPU uses sampled process-time deltas, normalized in the console to 0–100% of the available processor. The parenthesized capacity shows the combined per-core scale (for example, 800% for eight logical cores); the API retains the raw per-core reading and provides cpuCapacity for normalization. The first reading collects a baseline. Memory shows resident process memory (Windows working sets) alongside the configured maximum JVM heap. For Java arguments and recognized startup scripts, the panel reads the effective `-Xmx` or `-XX:MaxHeapSize` option, including `user_jvm_args.txt`; for example, `-Xmx12G` shows a 12 GB limit. A running server retains the limit read at its last start. While stopped, file edits update the displayed allocation for the next launch. Generic wrappers or arguments without a detectable fixed maximum show an unknown limit instead of an assumed 4 GB. Resident memory includes more than Java heap usage and shared pages can be counted in more than one child process. Queries are cached, coalesced across servers, bounded by a timeout, and reset across process restarts. Failed readings are shown as unavailable. Very short-lived children between samples may not be counted. Storage capacity is the host filesystem's capacity, not an enforced per-server quota.

Click the server icon on Console to upload a PNG, JPEG, or WebP image. The editor crops it to a square and converts it to a 64 × 64 PNG; saving an uploaded image writes `server-icon.png` in that server's folder, and the panel shows it immediately. Minecraft clients see a newly uploaded icon after a server restart. **Use default icon → Save icon** changes only this server's panel display preference and preserves the Minecraft PNG. **Use server icon → Save icon** shows that existing file again. Preferences survive app restarts and server switching. Icon uploads follow the same server-folder and backup protections as file changes.

For servers with no custom connection host, the panel detects this PC's public IPv4 using [ipify](https://www.ipify.org/) and combines it with the Minecraft port. Successful lookups are cached for ten minutes. Settings → **Player connection address** accepts a custom hostname, IPv4, or IPv6 address without a port, and can change while the server runs. This is the address copied for players; it does not set `server-ip`, open the firewall, configure the router, or verify that the port is reachable. Failed lookups fall back to a clearly labelled local address. Imported private bind addresses are separate from the public connection address. Software and loader version are detected from recognized Forge/NeoForge launch argument paths, including existing imported registrations; an undetectable launcher version is shown as unknown. For NeoForge, this is the loader version (such as 21.1.250), not the Minecraft version. Change `server.properties` to alter other actual Minecraft settings. The managed port and MOTD are available in Settings.

## Minecraft management

The **MINECRAFT** sidebar group contains **Versions**, **Launchpad**, and **Properties**. Each page uses the currently selected server; switching servers keeps asynchronous requests and installation jobs attached to their original server.

**Versions** lists official server distributions with bundled project logos and lets you choose a Minecraft release and build. Vanilla, Paper, Purpur, Folia, Velocity, Fabric, Quilt, Forge, and NeoForge support installation in the panel. Other distributions link to their official downloads. Experimental releases are hidden by default. Stop the server before confirming an installation. **Update runtime** is the default when the panel verifies the same software and Minecraft release, including recognized imported servers. It updates only runtime files and launch references, preserving worlds, mods, plugins, configuration, Java settings, and Launchpad installation records. For example, NeoForge 21.1.250 → 21.1.251 on Minecraft 1.21.1 is a runtime update. Switching software or Minecraft releases requires a **Clean install**; you can also explicitly choose one for the same runtime. Clean installs replace all contents of the selected server folder, including worlds, mods, plugins, configuration, and old startup files, and require an explicit acknowledgement. Downloads are checked against the provider's published checksum, and loader installers run in a private staging directory with the selected Java executable before existing files are moved. Replaced files remain outside the server folder in **File Manager → Recycle Bin**, and a failed promotion restores them. For a clean install, the panel keeps the server registration, selected Java, memory, port, and existing EULA decision while generating fresh startup settings. Runtime updates instead retain existing JVM arguments and recognized startup options; unsupported custom launchers cannot be updated automatically. Successful installation updates the saved launch configuration and leaves the server stopped. Velocity is a proxy: configure its bind address and backend connections in `velocity.toml` through File Manager.

**Launchpad** includes Modrinth, CurseForge, Spigot, Feed The Beast, ATLauncher, and Voids Wrath. Its content tabs are Modpacks, Mods, Datapacks, and Plugins; available content types depend on the platform. The Minecraft version dropdown includes stable Minecraft releases, newest first. Filter by version and loader, then use **Sort by** to choose a catalog-supported order such as downloads, popularity, recent updates, or name. Sorting applies across the catalog before pagination. When installing a modpack from the catalog, the dialog keeps your selected Minecraft version and loader; an **All** filter falls back to the current server's detected target. Individual content installs and **Installed only** updates default to the current server's detected Minecraft version and loader. You can adjust these targets before reviewing. Modpack reviews show the release, matching runtime, file count, and size without long lists of installing or skipped files. Individual mod, plugin, and datapack reviews still list the exact changes. Confirm installation while the server is stopped. Platform errors and publisher download restrictions are shown in the page. CurseForge needs your own API key, saved through **Platform settings** in private local panel data; the API never returns the saved key. Premium or externally hosted Spigot downloads require the publisher's own download flow.

Turn on **Installed only** in Mods to scan existing JARs and check compatible updates. **Sort by** offers **Updates first** (the default), **Name (A–Z)**, **Size (largest first)**, and **Mod author (A–Z)**. Sorting applies across all installed files before pagination; unknown authors appear last, and tied items are ordered by name. Catalog and installed sorting selections are kept separately while browsing. Modrinth hashes and verified CurseForge fingerprint matches identify files installed outside the panel; panel-installed files also have local receipts. Identified installed items load their project names, icons, and available author information even when no loader filter is selected. You can also search by author. An individual mod update replaces the identified old JAR rather than leaving duplicate versions, with the original retained in Recycle Bin. Unidentified files are left unchanged by individual mod updates. Installing a modpack replaces the entire server folder, with the same acknowledgement and Recycle Bin recovery as a clean install in Versions. Its matching runtime and content are prepared together and installed in one transaction, so installing another runtime afterward is unnecessary. Packs without a verifiable runtime or usable server download report the restriction before changing the server. Catalog reads need an Internet connection. Minecraft content is not updated automatically in the background.

Installed files from all platforms appear together, with a platform label on identified rows. They load locally first and remain visible while project details and update checks refresh. A matching path and checksum retain known names, icons, authors, and update badges during refresh; changed or deleted files never inherit those results. Update checks use the selected server's detected Minecraft version and supported loader, even when the catalog is set to **All versions**, **All loaders**, or another runtime. Imported Fabric and Quilt servers can derive the release from their launcher or game metadata. If the target is unknown, an inline notice asks for the missing version or loader. Changing the target discards old update recommendations.

Compatible update results are cached for five minutes. **Refresh** checks again with progress while leaving the list usable; repeated checks share the same background job. Failures on one project do not invalidate successful checks on another, and provider rate limits remain respected. Empty or unverifiable release lists show an unavailable check rather than **Up to date**. Modrinth checks run in batches, CurseForge release lookups page through results, and Quilt mod checks can include compatible Fabric releases. All replacements still verify the actual file bytes before review and installation. Runtime and content installation jobs exclude each other for the entire download and installation. Finished job banners survive a panel restart for up to ten minutes and can be dismissed. Closing or leaving a review releases its temporary files.

During a Launchpad installation, the server stays stopped and the panel reserves its files throughout downloading and promotion. Starting the server, changing configuration or files, and creating backups are temporarily blocked. A scheduled backup that encounters this lock records the failure and retries at its next scheduled time. This prevents another operation from changing the reviewed server while installation is in progress.

**Versions refresh** reloads the selected provider's releases and builds from the source while keeping the current selection and search. If a runtime update cannot be verified, the review explains why only clean installation is available.

In the desktop app, Launchpad project links and Versions' official software links open in your default web browser, including while connected to another computer. Identified installed content keeps its project link when older saved metadata lacks a website URL or a catalog refresh fails; unidentified files need a successful identification first.

Individual content installation reviews list only files that need changing. Files that already match the required download's checksum are omitted from the review and left in place without downloading or replacing them, including required dependencies. The installer rechecks those files before applying the reviewed changes. If a required Modrinth mod dependency points to the wrong loader, Launchpad can use a uniquely verified release of the same project with the exact same version number for the selected Minecraft version and loader. When a different dependency version is already installed on Forge or NeoForge, Launchpad keeps it if its verified JAR satisfies the requesting mod's declared dependency range. Its existing path and bytes stay unchanged; only actual changes appear in the review. Recovery remains blocked when the installed dependency's compatibility or a matching release cannot be verified. Missing catalog entries are shown as requirements needing review; **Install anyway** explicitly confirms installing only the listed compatible files. If every file already matches, no installation is needed.

**Properties** shows tabs for configuration files that actually exist: `server.properties`, `bukkit.yml`, `spigot.yml`, `pufferfish.yml`, `purpur.yml`, and Paper's global/world defaults. Search and edit scalar fields using typed inputs; YAML lists remain editable in File Manager. Saving preserves unrelated fields and comments, detects stale revisions, and keeps port/MOTD settings consistent with the server registry. Most properties can be saved while running and apply after restart; changing the managed port or MOTD requires stopping the server.

Use **Remove** on an installed mod to review removal while the server is stopped. Launchpad reads local Forge, NeoForge, Fabric, or Quilt declarations, including embedded libraries, and blocks removal when another installed mod requires it. Large mod archives and declared library containers are inspected without extracting their resources. Unreadable dependency metadata is listed separately and requires an explicit acknowledgement before removal; known dependents remain blocked. Inspect or repair affected files in File Manager before reviewing again. Alternate and conditional requirements are treated conservatively. Only the selected JAR moves to Recycle Bin; its dependencies, configuration, and other installed mods remain. Removing or replacing a mod after review invalidates that review. Restore a removed mod from File Manager's Recycle Bin.

The same reviewed **Remove** action is available for plugin JARs and datapack ZIPs in the selected world's datapacks folder; these do not use the mod dependency scan. Successful removal immediately drops the row while the inventory refreshes. Duplicate identified projects are marked **Duplicate — remove one**, and installation errors name the conflicting paths. Recycle Bin restore previews warn about a known duplicate before restoring a mod. An occupied restore path must be moved or deleted first. File Manager refreshes after a partially failed upload and audits the files that were successfully written.

Text search fields include a small clear button and a neutral keyboard focus outline. Clearing a search keeps keyboard focus in the field.

Installed Launchpad items retain their project links. **Update all** reviews compatible updates across platforms as one installation, including shared dependencies. More than fifty updates are split into explicitly labeled batches of fifty. Conflicting versions or file destinations stop the review. Modpack update checks are available too. A failed download can offer **Retry download** for fifteen minutes, reusing verified staged files; it never resumes a partially promoted installation. Stalls time out after sixty seconds without bytes, while progressing transfers may continue for up to thirty minutes. Closing the app cancels pending transfers and discards retry stages.

Modpack replacement moves old files into Recycle Bin. **Create a backup first** finishes a backup before installation starts, and a failed backup prevents installation. File Manager preserves UTF-8 and legacy Latin-1 text, including unchanged bytes; it rejects characters Latin-1 cannot represent. **Add operator** accepts a username even before that player appears in history, while existing-player actions retain their identity checks. Permission presets select explicit permissions and cannot grant permissions beyond the current account's authority.

## Backup scheduling and data

Schedules use the **API host's local timezone**, included in the API response and schedule interface. Each server's scheduler checks every 15 seconds and persists its next deadline in that server's `panel.json`. Keep the API running for jobs to execute. After downtime, one overdue job runs per server on the next check; missed intervals are not replayed in a burst.

Online backups send `save-off` followed by `save-all flush`, then wait up to 15 seconds for the vanilla, Paper, Forge, or NeoForge server logger to confirm that the game or world was saved. Chat and echoed commands cannot supply that confirmation. The archive is created while automatic world saving is paused. The panel sends `save-on` afterward, including failure paths. That server's file changes, settings, operator commands, console commands, and power controls are blocked during a backup; other servers remain usable. If a save is not confirmed, no archive is created and the failure appears in Audit Logs. Unsupported server implementations can be backed up while stopped. Plugin-managed files may still change independently; stop the server for a fully quiescent archive of those files.

A scheduled failure is recorded in Audit Logs and the job tries again at its next deadline. Backup restore is not implemented; downloaded archives can be restored manually while the server is stopped.

Storage layout (all ignored by Git):

```text
data/
  server/       legacy or browser-development default server files
  backups/      that legacy server's gzip-compressed tar archives
  uploads/      that legacy server's temporary upload storage
  recycle-bin/  that legacy server's recoverable deleted files and journals
  panel.json    that legacy server's schedules, metadata, and audit events
  servers.json  server registry and saved configurations
  instances/
    <server-id>/
      server/       that server's Minecraft files
      backups/      that server's archives
      uploads/      that server's temporary uploads
      recycle-bin/  that server's recoverable deleted files and journals
      panel.json    that server's schedule, player history, records, and audit
```

An empty desktop workspace contains the server registry and, after a selection has been saved, `desktop-selection.json`. Servers created through the panel use their own `instances/<server-id>/` directory, including the first server. Imported servers use that directory for panel metadata and backups while keeping Minecraft files in the selected external folder. Existing storage locations are preserved when switching the default server or removing a server from the panel.

The Recycle Bin is a protected virtual folder in File Manager. It allows restoring or permanently deleting selected recovery items, with confirmation before permanent deletion; uploads and editing remain disabled. Permanent deletion cannot be undone and affects only the selected private recovery entries, including incomplete entries. Failed deletions retain any remaining data for retry, and partially deleted entries cannot be restored. Recovery data otherwise remains in the panel's data directory across restarts and updates. Files and folders can be deleted and restored while the server is running, including across drives. Cross-drive moves verify the recovery copy before removing copied entries; new files created during removal are left intact. Detected changes or file locks report an error and retain recovery data. Restore creates missing parent directories, preserves copied file modes and modification times, and leaves both versions intact if the original path is occupied. The bin does not include files deleted before this feature was installed or files deleted outside MC Panel.

`PANEL_DATA_DIR` changes the panel's data directory. Keep it outside a custom server directory so backups never archive themselves. Use only one API process per data directory. There is no background service installer; scheduling runs within the API process.

API clients can list/create servers at `/api/servers` and update one at `/api/servers/:id`. Creating a server configures a Java process; start it after installing or importing its server software. `DELETE /api/servers/:id` removes an offline server from the registry without deleting its Minecraft files, backups, or Recycle Bin data. It returns 409 if the server is running or has an operation in progress. Select a server for existing APIs with the `X-Server-Id` header or the `serverId` query parameter for direct download links. Unknown IDs return 404; conflicting selectors return 400. Calls without either selector use the current default server. An empty fleet has `defaultServerId: null`, and server-specific API calls return 404 until a server is created.

Guided creation reads `/api/server-setup`, `/api/server-setup/versions/:provider`, and `/api/server-setup/launchpad/search` without a selected server. `/api/server-setup/preflight` checks the proposed Java and memory settings; `/api/server-setup/modpack-preview` reviews an exact modpack release. Confirmed creation uses `POST /api/server-setup` with a persistent `requestId`, `confirmed: true`, explicit `acceptedEula`, and `configuration`; repeating that request returns the same registration. Installation and progress calls then use the created server's `X-Server-Id` so another selected server is unaffected.

Owner-only recovery uses `GET /api/server-recovery`, `GET /api/server-recovery/:id`, and `POST /api/server-recovery/:id` with the reviewed `revision`, `confirmed: true`, and startup settings. Only canonical managed instance folders are eligible; changed reviews, linked folders, overlapping paths, and conflicting ports are rejected. Windows CI checks the updater manifest's version, installer filename, byte size, and streamed SHA-512 before publishing.

For imports, `GET /api/server-import` reports native browsing availability. `POST /api/server-import/browse` opens the desktop folder picker and returns a selected `directory` or `null` on cancellation. `POST /api/server-import/inspect` accepts `{ "directory": "absolute path" }` and returns detected settings without modifying source files. `POST /api/server-import` accepts `directory`, `name`, `jar`, `javaPath`, `memoryLimitMB`, and `port`, revalidates the source, and returns a stopped server with its saved Java startup configuration. Imported server descriptors include `source: "imported"` and `serverDir`; unavailable imports also include `unavailable` and `sourceError`.

## Invite someone to control a server from their phone

The local panel remains the owner's administration interface. Remote access uses a separate authenticated listener, disabled until configured in **Subusers → Set up phone access**. You do not need to own a domain or configure an email provider.

1. Open **Subusers** in the local owner panel. Choose an unused **Remote access port** (`3002` by default). Click **Use my public IP**, or enter a **Public panel address** such as `https://203.0.113.10:3002`. Public IP discovery runs only when you click the button; it also shows this computer's local network addresses. Enter your actual public IP, not the example address.
2. In your router, forward the chosen **TCP** port to this computer's local network IP, using the same internal port. Reserve that local IP in the router so it does not change. Allow the chosen port through Windows Firewall. This is the panel's port, separate from Minecraft's game port. MC Panel does not change router or firewall settings automatically.
3. Check **Enable remote access**, then **Save access settings**. MC Panel starts HTTPS itself and generates a certificate for the configured address. No certificate files need to be supplied.
4. Check the public address from your phone using mobile data. Browsers will warn because the generated certificate is self-signed. Share the **Certificate SHA-256 fingerprint** shown in setup through a trusted channel; compare it with the certificate presented by the browser before trusting that certificate. Do not continue if they differ. A changed address or regenerated certificate requires checking the new fingerprint. Some mobile browsers make inspecting and trusting certificates difficult; a trusted HTTPS proxy remains available in **Advanced connection options**.
5. Select the server, click **New user**, enter the recipient's email as their sign-in identifier, and choose permissions. **Use Control preset** grants console, start, stop, and restart. Leave **Create invitation link** checked and click **Create subuser**. Copy the resulting link and send it privately through your usual text or email app. MC Panel sends no email. If clipboard access is unavailable, select and copy the displayed link manually; retrying **Copy link** keeps the same invitation.
6. The recipient opens the link and chooses a password of at least 12 characters. On later visits they sign in using their email and password. Keep this computer and MC Panel running whenever remote access is needed.

Invitation links work once and expire after 24 hours; sessions last up to seven days. The raw invitation is displayed only when created, so copy it before closing its window. **Create invite link** produces a replacement and invalidates previous unused links for that invitation. **Reset access** creates a new password setup link for an activated user. After confirmation, their current password and sessions for this server stop working immediately; they regain access by accepting the new link. Credentials for their other servers remain unchanged. **Save permissions** changes what the subuser can do immediately. Removing their access disables their sessions and invitation links for that server. Subusers can also be saved before remote setup, then invited from their row later.

If your public IP changes, update the public address in setup and share the new address and certificate fingerprint. A successful save confirms local configuration, not Internet reachability. If your provider uses CGNAT or blocks incoming connections, router port forwarding alone will not work; request a public IP from your provider or use an HTTPS tunnel. Double NAT may require configuring both routers.

An existing HTTPS reverse proxy or tunnel remains supported through **Advanced connection options → HTTPS handled by a proxy**. Route it to `http://127.0.0.1:3002` (or your selected remote port), use a dedicated public HTTPS origin without a path, and preserve the public `Host` header. Existing proxy configurations retain this mode when updating. Existing email-based accounts need a new invitation to choose a password; they no longer request sign-in emails.

Only servers the signed-in person has been invited to appear in the remote session. Permission checks apply to every server request, including direct downloads. Access settings, server creation/import/removal, and owner configuration remain local administrative actions. A delegated user can only grant permissions they also have. Remote settings, hashed credentials, session state, and the private TLS certificate material are stored inside the panel data directory; protect that directory.

## Local access boundary

The owner API and development frontend bind to `127.0.0.1`. The owner API rejects nonlocal Host headers and cross-site mutation requests. The desktop app additionally protects its randomly assigned local port with a private session cookie and accepts only its own origin. **Never forward or route a public proxy or tunnel to the owner API (`3001` by default), Vite development server, or desktop session port.** Expose only the separate remote access port (`3002` by default), which requires a password-authenticated secure session and the subuser's server permissions. Direct mode serves HTTPS on this port; optional proxy mode serves HTTP on loopback behind the HTTPS proxy.

## Verify

```sh
npm test
npm run build
```

Integration tests exercise original-byte uploads/downloads, editing and deletion, path traversal and symlink rejection, request-origin checks, readable backup archives, persistence and retention, missed schedule handling, access records, process-backed console controls, and online Java backup coordination with a controlled process fixture. Fleet tests also check server isolation, selector validation, legacy migration, rename persistence, unique-port creation races, launch races, and validated OP/deOP commands. Tests use isolated temporary directories and do not touch your server data.

Browser integration tests cover the console, file editor and transfers, backup downloads and schedules, subuser permissions and invitation retries, audit filtering, and mobile layouts:

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

The browser suite starts an isolated backend on port 3111 and removes its temporary data afterward. To use an already installed Chrome instead of downloading Chromium, set `PLAYWRIGHT_CHANNEL=chrome` in your shell. A real Minecraft JAR has not been tested as part of this initial development build; live-process integration is covered with a controlled process stub.
