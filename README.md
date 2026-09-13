# Minecraft Server UI

A local Minecraft server panel inspired by the navigation and console layout of Apollo. Available as a Windows desktop app or a browser-based development server. Built with React, TypeScript, Vite, and an Express API, with Electron for the desktop app. Development work is on the `dev` branch.

## Windows desktop app

**MC Panel runs in its own Windows window and includes its Node.js runtime.** End users do not need to install Node.js, use a terminal, or start a separate web server. Running a real Minecraft server still requires the Java version expected by its server software. Configure the Java executable and startup settings, and accept the Minecraft EULA yourself. Install the desktop app on the computer that will run Minecraft; it cannot attach to a Java process on another PC.

A fresh desktop workspace starts with no servers. **Add your first server** offers two paths: **Create a new server** or **Import an existing server**. New servers default to Minecraft Java. Demo mode remains optional.

The Windows x64 build produces two executables in `release/`:

| File                                    | Use                                            |
| --------------------------------------- | ---------------------------------------------- |
| `MC-Panel-0.1.3-dev.0-Setup-x64.exe`    | Install MC Panel, then launch it from Windows. |
| `MC-Panel-0.1.3-dev.0-Portable-x64.exe` | Run MC Panel without installing it.            |

The version in each filename follows `package.json`. These development builds are unsigned, so Windows may report an unknown publisher or show a SmartScreen notice. A code-signing certificate is not configured.

Closing the window keeps MC Panel in the Windows notification area so running servers and backup schedules can continue. Reopen it from its tray icon. Choose **Quit MC Panel** in the desktop or tray menu to exit completely; when Java servers are running, the app asks before stopping them and shutting down. Quit waits for active backups and file changes to finish before stopping Java. Servers and schedules run only while the app is running. Saved Java servers stay stopped after you reopen the app until you choose **Start**. Press **Alt** to show the desktop menu. Its **Panel** menu also provides **Open server data folder**, **Open downloads folder**, and **Help and documentation**.

### Desktop data

Both the installed and portable editions save the server registry, panel settings, backups, and newly created server files under:

```text
%APPDATA%\MC Panel\data
```

This is separate from the repository's `data/` directory, so the desktop app does not automatically import an existing development workspace. The portable executable uses the same per-user data location; it does not keep worlds beside the executable. App upgrades and uninstalling the app preserve this data. Use **Open server data folder** to find it, and retain your own backups before moving or removing server files. Existing custom Minecraft directories remain in their configured locations. Desktop startup and shutdown errors are recorded one level above this folder in `%APPDATA%\MC Panel\desktop.log`.

To remove a demo or live server from the panel, stop it, open its **Settings**, choose **Remove server**, review the name, and confirm removal. Removal stops its backup schedule and preserves its Minecraft files, worlds, backups, and Recycle Bin data on disk. Imported files remain in their original folder. Removing the last server returns to the welcome screen; it stays empty after restarting the app. You can import a preserved server folder again later.

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

The [Windows desktop workflow](.github/workflows/windows-desktop.yml) runs on pushes to `dev` and can also be started manually. It builds both executables, runs backend and desktop unit tests, browser tests, and the packaged-app smoke test. A successful current `dev` build publishes a GitHub prerelease with a unique version, such as `0.1.3-dev.12.1`, the installer, portable copy, and updater metadata. Other branches produce workflow artifacts only. Incomplete builds remain unpublished, superseded commits are skipped, and older reruns cannot replace a newer dev update. Workflow artifacts expire after 14 days; published releases remain available.

### Update MC Panel

Install the **Setup** edition once on the server PC to enable updates. Earlier builds do not have an updater, so installing this first updater-enabled build is the one-time bootstrap. Future updates use **Updates → Check for updates → Download update → Restart to update**. The app also checks in the background after launch and every four hours, but never downloads, installs, or stops a server without an update action.

Updates download from this repository's published dev releases and are checked against the release manifest's SHA-512 checksum by `electron-updater`. No GitHub login or token is bundled into the app. These development builds are unsigned; checksum verification is not a publisher signature. Portable/unpacked copies explain that the Setup edition is required rather than launching an installer over themselves.

Downloading leaves servers running. Applying an update asks before stopping running servers, waits for active backups and writes, then waits for graceful server exit before replacing the app. It preserves `%APPDATA%\MC Panel` and imported server folders. MC Panel reopens after installation with servers stopped; start them when ready. An offline network, failed download, or unavailable dev release can be retried from the same dialog. Updates change MC Panel only; they do not update Minecraft, Java, NeoForge, or mods.

## Run from source in a browser

Install **Node.js 24 or newer**, then:

```sh
npm install
npm run dev
```

The repository also includes a pnpm lockfile. With pnpm installed, use `pnpm install --frozen-lockfile` and `pnpm dev` for the locked dependency versions.

Open **http://127.0.0.1:5173**. Vite forwards API requests to the local backend on port 3001. The first run creates a small demonstration workspace in `data/server/`. Console messages, power controls, CPU, and memory readings are clearly labelled simulations until a Java server is configured. File operations, backups, SQLite databases, schedules, and audit entries operate on real files even in demo mode.

For a compiled build:

```sh
npm run build
npm start
```

Open **http://127.0.0.1:3001**. `npm run preview` previews only the built frontend; use `npm start` for the complete application.

## What works

- **Multiple servers:** create independent demo or live Java servers, switch between them, and rename them. Each server has its own console, files, backups, schedule, access records, databases, in-game operators, and audit logs. Servers can run concurrently on distinct ports.
- **Console:** start, stop, restart, timestamped output, command entry, resource charts, and server status. Turn on **Server messaging** beside Autoscroll to broadcast text to all players without typing `say`; command and message drafts/history stay separate. In live mode commands go directly to the server process's standard input, never to an operating system shell.
- **Players:** view Online Players, Banned Players, Operators, and Whitelist together, with Player History below. Each list starts with five players per page and has previous/next controls plus a choice of 5, 10, 25, 50, 75, or 100 rows. Row counts are saved independently in this browser; longer lists scroll within their panel. Actions beside names let you grant/remove OP, kick, ban/unban, or add/remove whitelist entries. The whitelist toggle enables or disables restricted joining. Live actions send Minecraft commands to the running server; check Console for the result. Rosters and the whitelist toggle read `ops.json`, `banned-players.json`, `whitelist.json`, and `server.properties`, so they can lag behind a command. History persists observed joins/leaves and includes saved profiles with Minecraft heads. Saved profiles may never have joined, and cache expiry is never presented as a login date. Demo actions are simulated and do not modify Minecraft permission files or whitelist settings.
- **File Manager:** browse folders, create files and directories, edit text files up to 1 MB, and upload/download original files. Deletion moves files or whole folders to a protected, per-server **Recycle Bin** outside the Minecraft folder. Restore returns an item to its original path and refuses to overwrite anything already there. Items remain until restored or explicitly deleted permanently; there is no automatic expiry. Row checkboxes support bulk moves, restores, and permanent deletion. Select-all affects visible rows without moving the checkbox, confirmations name selected recovery items, and failed actions stay selected for retry. Upload up to 20 files per request, 256 MB per file. Existing names are protected from accidental upload overwrites. Paths and symbolic links are checked to keep operations inside the configured server directory.
- **Backups:** create and download real `.tar.gz` archives; configure interval, daily, or weekly schedules and retention. Manual backups are kept until deleted. Retention applies only to scheduled backups, after a new archive succeeds. Symbolic links are excluded.
- **Subusers:** store email and intended permission selections locally, with grouped Control, User, Files, Backups, Databases, and Audit controls. Existing role records receive equivalent default selections and can be edited. These records do **not** create authenticated accounts, enforce permissions, or send invitations. All access to this local panel has administrator capabilities.
- **Databases:** create, download, and delete actual SQLite files. This is local SQLite storage, not a hosted MySQL service or automatic Minecraft plugin configuration.
- **Audit Logs:** persistent records of server commands, settings, in-game operator changes, file changes, backup jobs, local access records, and database changes. The most recent 2,000 events are retained per server.

## Manage multiple servers

Use the server selector to switch workspaces and add a server. Choose **demo** for simulated activity or **live** to run an actual Java server. Give each server a unique Minecraft port (1024–65535) and its own Java heap allocation. The panel creates a separate server directory for every new server. New live instances contain `eula=false` and a starter `server.properties`; upload your JAR in File Manager, configure Java, and accept the EULA yourself before starting.

The server's **display name** can change while it runs. Its **server list message (MOTD)** is a separate setting, shown in Minecraft's multiplayer server list. Stop a server before changing its MOTD, port, mode, Java executable, JAR, or memory allocation. The selected port is written to `server.properties` when settings change and checked again at launch. Renaming alone does not change the MOTD.

Switching servers does not stop them or pause their backup schedules. Files and permissions always belong to the server selected when the operation was started. In-game OP access belongs in **Players**; **Subusers** continues to hold local panel access records and does not grant Minecraft permissions.

## Connect a real Java server

For a new server, use the server selector and settings as described above. To import an existing server directory into a fresh panel installation:

1. Copy `.env.example` to `.env` before the first startup.
2. Set `MC_SERVER_DIR` to your existing Minecraft server directory, and `MC_SERVER_JAR` to the JAR filename inside that directory. Set `JAVA_PATH` if Java is not available on your PATH. Use the Java version required by your chosen server JAR.
3. Read and accept the [Minecraft EULA](https://aka.ms/MinecraftEULA) yourself, then set `eula=true` in the server's `eula.txt`.
4. Set `MC_MEMORY_MB` and the optional server display settings, then start the panel and use **Start**.

The first fleet startup imports the original default server's configuration and existing files, backups, schedules, access records, and databases without moving or deleting them. The registry is saved in `data/servers.json`. After that, edit server settings in the panel: changing `MC_*` or `JAVA_PATH` in `.env` does not override saved server settings. `PORT` and `PANEL_DATA_DIR` still configure the API process. Environment settings for the original server are never implicitly applied to newly created servers.

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

The panel owns the Java process it launches. It cannot attach to an already running server. A normal panel shutdown sends `stop` and waits up to 15 seconds before terminating the process. Software and content downloads happen only after you select and confirm an installation in Versions or Launchpad. Your EULA choice is preserved. A custom `MC_SERVER_DIR` is never populated with demonstration files. Use the **Import an existing server** interface for NeoForge startup detection; the legacy environment example above configures a JAR server.

Live stdout, commands, power state, uptime, disk usage, in-game operator commands, and online-player tracking work. The online-player list follows recognized vanilla/Paper join and leave messages from the Java process launched by the panel. UUID authentication announcements supply player UUIDs when available. Tracking starts with that process and clears on stop, exit, and restart; it does not read old logs or attach to a separate running server. Plugins or server versions that replace these standard log messages may prevent complete tracking. This is log tracking, not a server query, and no player latency is invented. Demo mode keeps the online-player list empty.

The Console and Players pages fetch Minecraft head images in the browser from [MCHeads](https://mc-heads.net/), using the player's UUID when available and their username otherwise. No API key is needed. If an image cannot load, the panel shows its local default head.

Live CPU and memory readings cover the server process and its descendants. Windows uses [CIM process counters](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process), Linux uses `/proc`, and macOS uses `ps`. CPU uses sampled process-time deltas, normalized in the console to 0–100% of the available processor. The parenthesized capacity shows the combined per-core scale (for example, 800% for eight logical cores); the API retains the raw per-core reading and provides cpuCapacity for normalization. The first reading collects a baseline. Memory shows resident process memory (Windows working sets) alongside the configured maximum JVM heap. For Java arguments and recognized startup scripts, the panel reads the effective `-Xmx` or `-XX:MaxHeapSize` option, including `user_jvm_args.txt`; for example, `-Xmx12G` shows a 12 GB limit. A running server retains the limit read at its last start. While stopped, file edits update the displayed allocation for the next launch. Generic wrappers or arguments without a detectable fixed maximum show an unknown limit instead of an assumed 4 GB. Resident memory includes more than Java heap usage and shared pages can be counted in more than one child process. Queries are cached, coalesced across servers, bounded by a timeout, and reset across process restarts. Failed readings are shown as unavailable. Very short-lived children between samples may not be counted. Storage capacity is the host filesystem's capacity, not an enforced per-server quota.

Click the server icon on Console to upload a PNG, JPEG, or WebP image. The editor crops it to a square and converts it to a 64 × 64 PNG; saving an uploaded image writes `server-icon.png` in that server's folder, and the panel shows it immediately. Minecraft clients see a newly uploaded icon after a server restart. **Use default icon → Save icon** changes only this server's panel display preference and preserves the Minecraft PNG. **Use server icon → Save icon** shows that existing file again. Preferences survive app restarts and server switching. Icon uploads follow the same server-folder and backup protections as file changes.

For live servers with no custom connection host, the panel detects this PC's public IPv4 using [ipify](https://www.ipify.org/) and combines it with the Minecraft port. Successful lookups are cached for ten minutes. Settings → **Player connection address** accepts a custom hostname, IPv4, or IPv6 address without a port, and can change while the server runs. This is the address copied for players; it does not set `server-ip`, open the firewall, configure the router, or verify that the port is reachable. Failed lookups fall back to a clearly labelled local address. Imported private bind addresses are separate from the public connection address. Software and loader version are detected from recognized Forge/NeoForge launch argument paths, including existing imported registrations; an undetectable launcher version is shown as unknown. For NeoForge, this is the loader version (such as 21.1.250), not the Minecraft version. Change `server.properties` to alter other actual Minecraft settings. The managed port and MOTD are available in Settings.

## Minecraft management

The **MINECRAFT** sidebar group contains **Versions**, **Launchpad**, and **Properties**. Each page uses the currently selected server; switching servers keeps asynchronous requests and installation jobs attached to their original server.

**Versions** lists official server distributions and lets you choose a Minecraft release and build. Vanilla, Paper, Purpur, Folia, Velocity, Fabric, Quilt, Forge, and NeoForge support installation in the panel. Other distributions link to their official downloads. Experimental releases are hidden by default. Stop the server before confirming an installation. Downloads are checked against the provider's published checksum, and loader installers run in a private staging directory with the selected Java executable. Only generated software files are promoted; existing worlds, mods, configuration, `user_jvm_args.txt`, and startup scripts are preserved. Replaced software files remain in Recycle Bin, and a failed promotion restores the previous files. Successful installation updates the saved launch configuration and leaves the server stopped. Choose compatible mods and the required Java version before starting. Velocity is a proxy: configure its bind address and backend connections in `velocity.toml` through File Manager.

**Launchpad** includes Modrinth, CurseForge, Spigot, Feed The Beast, ATLauncher, and Voids Wrath. Its content tabs are Modpacks, Mods, Datapacks, and Plugins; available content types depend on the platform. Search by Minecraft version and loader, then use **Sort by** to choose a catalog-supported order such as downloads, popularity, recent updates, or name. Sorting applies across the catalog before pagination. Choose a release, review the exact destination files, then confirm installation while the server is stopped. Platform errors and publisher download restrictions are shown in the page. CurseForge needs your own API key, saved through **Platform settings** in private local panel data; the API never returns the saved key. Premium or externally hosted Spigot downloads require the publisher's own download flow.

Turn on **Installed only** in Mods to scan existing JARs and check compatible updates. Files with available updates appear first across all pages, with alphabetical ordering within the update and remaining-file groups. Modrinth hashes and verified CurseForge fingerprint matches identify files installed outside the panel; panel-installed files also have local receipts. An update replaces the identified old JAR rather than leaving duplicate versions, with the original retained in Recycle Bin. Unidentified files are left unchanged. Modpack installation preserves world folders and server identity/access settings, and checks the target runtime and loader. Packs without a usable server download report the provider restriction. Catalog reads need an Internet connection. Minecraft content is not updated automatically in the background.

**Properties** shows tabs for configuration files that actually exist: `server.properties`, `bukkit.yml`, `spigot.yml`, `pufferfish.yml`, `purpur.yml`, and Paper's global/world defaults. Search and edit scalar fields using typed inputs; YAML lists remain editable in File Manager. Saving preserves unrelated fields and comments, detects stale revisions, and keeps port/MOTD settings consistent with the server registry. Most properties can be saved while running and apply after restart; changing the managed port or MOTD requires stopping the server.

## Backup scheduling and data

Schedules use the **API host's local timezone**, included in the API response and schedule interface. Each server's scheduler checks every 15 seconds and persists its next deadline in that server's `panel.json`. Keep the API running for jobs to execute. After downtime, one overdue job runs per server on the next check; missed intervals are not replayed in a burst.

Online backups send `save-off` followed by `save-all flush`, then wait up to 15 seconds for the vanilla/Paper console to confirm that the game or world was saved. The archive is created while automatic world saving is paused. The panel sends `save-on` afterward, including failure paths. That server's file changes, settings, operator commands, console commands, and power controls are blocked during a backup; other servers remain usable. If a save is not confirmed, no archive is created and the failure appears in Audit Logs. Unsupported server implementations can be backed up while stopped. Plugin-managed databases and files may still change independently; stop the server for a fully quiescent archive of those files.

A scheduled failure is recorded in Audit Logs and the job tries again at its next deadline. Backup restore is not implemented; downloaded archives can be restored manually while the server is stopped.

Storage layout (all ignored by Git):

```text
data/
  server/       legacy or browser-development default server files
  backups/      that legacy server's gzip-compressed tar archives
  databases/    that legacy server's SQLite files
  uploads/      that legacy server's temporary upload storage
  recycle-bin/  that legacy server's recoverable deleted files and journals
  panel.json    that legacy server's schedules, metadata, and audit events
  servers.json  server registry and saved configurations
  instances/
    <server-id>/
      server/       that server's Minecraft files
      backups/      that server's archives
      databases/    that server's SQLite files
      uploads/      that server's temporary uploads
      recycle-bin/  that server's recoverable deleted files and journals
      panel.json    that server's schedule, player history, records, and audit
```

An empty desktop workspace contains only `servers.json`. Servers created through the panel use their own `instances/<server-id>/` directory, including the first server. Imported servers use that directory for panel metadata and backups while keeping Minecraft files in the selected external folder. Existing storage locations are preserved when switching the default server or removing a demo.

The Recycle Bin is a protected virtual folder in File Manager. It allows restoring or permanently deleting selected recovery items, with confirmation before permanent deletion; uploads and editing remain disabled. Permanent deletion cannot be undone and affects only the selected private recovery entries, including incomplete entries. Failed deletions retain any remaining data for retry, and partially deleted entries cannot be restored. Recovery data otherwise remains in the panel's data directory across restarts and updates. Files and folders can be deleted and restored while the server is running, including across drives. Cross-drive moves verify the recovery copy before removing copied entries; new files created during removal are left intact. Detected changes or file locks report an error and retain recovery data. Restore creates missing parent directories, preserves copied file modes and modification times, and leaves both versions intact if the original path is occupied. The bin does not include files deleted before this feature was installed or files deleted outside MC Panel.

`PANEL_DATA_DIR` changes the panel's data directory. Keep it outside a custom server directory so backups never archive themselves. Use only one API process per data directory. There is no background service installer; scheduling runs within the API process.

API clients can list/create servers at `/api/servers` and update one at `/api/servers/:id`. Creating a server defaults to live Java mode; simulations require `mode: "demo"`. `DELETE /api/servers/:id` removes an offline demo or live server from the registry without deleting its Minecraft files, backups, or Recycle Bin data. It returns 409 if the server is running or has an operation in progress. Select a server for existing APIs with the `X-Server-Id` header or the `serverId` query parameter for direct download links. Unknown IDs return 404; conflicting selectors return 400. Calls without either selector use the current default server. An empty fleet has `defaultServerId: null`, and server-specific API calls return 404 until a server is created.

For imports, `GET /api/server-import` reports native browsing availability. `POST /api/server-import/browse` opens the desktop folder picker and returns a selected `directory` or `null` on cancellation. `POST /api/server-import/inspect` accepts `{ "directory": "absolute path" }` and returns detected settings without modifying source files. `POST /api/server-import` accepts `directory`, `name`, `jar`, `javaPath`, `memoryLimitMB`, and `port`, revalidates the source, and returns a stopped live server. Imported server descriptors include `source: "imported"` and `serverDir`; unavailable imports also include `unavailable` and `sourceError`.

## Local access boundary

The server and development frontend bind to `127.0.0.1`. The API rejects nonlocal Host headers and cross-site mutation requests. The browser development server has no login or user authorization, so do not expose it through a public reverse proxy or tunnel. The desktop app additionally protects its randomly assigned local port with a private session cookie and accepts only its own origin. Neither edition provides authenticated Subuser accounts or role enforcement for remote hosting.

## Verify

```sh
npm test
npm run build
```

Integration tests exercise original-byte uploads/downloads, editing and deletion, path traversal and symlink rejection, request-origin checks, readable backup archives, persistence and retention, missed schedule handling, SQLite validity, access records, simulated console controls, and online Java backup coordination with a stub process. Fleet tests also check server isolation, selector validation, legacy migration, rename persistence, unique-port creation races, launch races, and validated live OP/deOP commands. Tests use isolated temporary directories and do not touch your server data.

Browser integration tests cover the console, file editor and transfers, backup downloads and schedules, local access records, SQLite downloads, audit filtering, and mobile layouts:

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

The browser suite starts an isolated backend on port 3111 and removes its temporary data afterward. To use an already installed Chrome instead of downloading Chromium, set `PLAYWRIGHT_CHANNEL=chrome` in your shell. A real Minecraft JAR has not been tested as part of this initial development build; live-process integration is covered with a controlled process stub.
