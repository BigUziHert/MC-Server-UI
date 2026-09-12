# Minecraft Server UI

A local Minecraft server panel inspired by the navigation and console layout of Apollo. Available as a Windows desktop app or a browser-based development server. Built with React, TypeScript, Vite, and an Express API, with Electron for the desktop app. Development work is on the `dev` branch.

## Windows desktop app

**MC Panel runs in its own Windows window and includes its Node.js runtime.** End users do not need to install Node.js, use a terminal, or start a separate web server. Running a real Minecraft server still requires the Java version expected by its server JAR. Configure the Java executable, JAR, and memory in that server's settings, and accept the Minecraft EULA yourself.

The Windows x64 build produces two executables in `release/`:

| File                              | Use                                            |
| --------------------------------- | ---------------------------------------------- |
| `MC-Panel-0.1.0-Setup-x64.exe`    | Install MC Panel, then launch it from Windows. |
| `MC-Panel-0.1.0-Portable-x64.exe` | Run MC Panel without installing it.            |

The version in each filename follows `package.json`. These development builds are unsigned, so Windows may report an unknown publisher or show a SmartScreen notice. A code-signing certificate is not configured.

Closing the window keeps MC Panel in the Windows notification area so running servers and backup schedules can continue. Reopen it from its tray icon. Choose **Quit MC Panel** in the desktop or tray menu to exit completely; when Java servers are running, the app asks before stopping them and shutting down. Quit waits for active backups and file changes to finish before stopping Java. Servers and schedules run only while the app is running. Saved Java servers stay stopped after you reopen the app until you choose **Start**. Press **Alt** to show the desktop menu. Its **Panel** menu also provides **Open server data folder**, **Open downloads folder**, and **Help and documentation**.

### Desktop data

Both the installed and portable editions save their server registry, worlds, backups, and settings under:

```text
%APPDATA%\MC Panel\data
```

This is separate from the repository's `data/` directory, so the desktop app does not automatically import an existing development workspace. The portable executable uses the same per-user data location; it does not keep worlds beside the executable. App upgrades and uninstalling the app preserve this data. Use **Open server data folder** to find it, and retain your own backups before moving or removing server files. Existing custom Minecraft directories remain in their configured locations. Desktop startup and shutdown errors are recorded one level above this folder in `%APPDATA%\MC Panel\desktop.log`.

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

The [Windows desktop workflow](.github/workflows/windows-desktop.yml) installs locked dependencies on a Windows runner, builds both executables, runs the backend and desktop unit tests, browser suite, and packaged-app smoke test, and uploads the executables as a workflow artifact. It is started manually with `workflow_dispatch` and does not publish a GitHub release. Once the workflow is available on the repository's default branch, choose **Windows desktop** in GitHub Actions, select the branch to build, and run it. Download the `MC-Panel-windows-x64` artifact from the completed run and extract the executables. Workflow artifacts expire after 14 days.

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
- **Console:** start, stop, restart, timestamped output, command entry, resource charts, and server status. In live mode commands go directly to the Java process's standard input, never to an operating system shell.
- **Players:** grant or remove Minecraft operator access using a Java username. Live actions send `op <name>` or `deop <name>` to the running server and report that the command was requested; check the console for Minecraft's result. The operator list reads the server's `ops.json`, so it can lag behind a command. Demo operator changes are clearly simulated and saved separately from `ops.json`.
- **File Manager:** browse folders, create files and directories, edit text files up to 1 MB, delete files or folders, and upload/download original files. Upload up to 20 files per request, 256 MB per file. Existing names are protected from accidental upload overwrites. Paths and symbolic links are checked to keep operations inside the configured server directory.
- **Backups:** create and download real `.tar.gz` archives; configure interval, daily, or weekly schedules and retention. Manual backups are kept until deleted. Retention applies only to scheduled backups, after a new archive succeeds. Symbolic links are excluded.
- **Subusers:** store email and role records locally. These records do **not** create authenticated accounts, enforce permissions, or send invitations. All access to this local panel has administrator capabilities.
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

The panel owns the Java process it launches. It cannot attach to an already running server. A normal panel shutdown sends `stop` and waits up to 15 seconds before terminating the process. The panel does not download JARs, change your EULA, or install plugins automatically. A custom `MC_SERVER_DIR` is never populated with demonstration files.

Live stdout, commands, power state, uptime, disk usage, in-game operator commands, and online-player tracking work. The online-player list follows recognized vanilla/Paper join and leave messages from the Java process launched by the panel. UUID authentication announcements supply player UUIDs when available. Tracking starts with that process and clears on stop, exit, and restart; it does not read old logs or attach to a separate running server. Plugins or server versions that replace these standard log messages may prevent complete tracking. This is log tracking, not a server query, and no player latency is invented. Demo mode keeps the online-player list empty.

The Console and Players pages fetch Minecraft head images in the browser from [MCHeads](https://mc-heads.net/), using the player's UUID when available and their username otherwise. No API key is needed. If an image cannot load, the panel shows its local default head.

Live CPU/memory telemetry is not yet connected; the API marks those readings unavailable rather than presenting simulated values as real measurements. Storage capacity is the host filesystem's capacity, not an enforced per-server quota. Memory allocation is enforced through the Java heap arguments. Version, software, maximum player count, and the imported address are display configuration; change `server.properties` to alter other actual Minecraft server settings. The managed port and MOTD are available in the panel's server settings.

## Backup scheduling and data

Schedules use the **API host's local timezone**, included in the API response and schedule interface. Each server's scheduler checks every 15 seconds and persists its next deadline in that server's `panel.json`. Keep the API running for jobs to execute. After downtime, one overdue job runs per server on the next check; missed intervals are not replayed in a burst.

Online backups send `save-off` followed by `save-all flush`, then wait up to 15 seconds for the vanilla/Paper console to confirm that the game or world was saved. The archive is created while automatic world saving is paused. The panel sends `save-on` afterward, including failure paths. That server's file changes, settings, operator commands, console commands, and power controls are blocked during a backup; other servers remain usable. If a save is not confirmed, no archive is created and the failure appears in Audit Logs. Unsupported server implementations can be backed up while stopped. Plugin-managed databases and files may still change independently; stop the server for a fully quiescent archive of those files.

A scheduled failure is recorded in Audit Logs and the job tries again at its next deadline. Backup restore is not implemented; downloaded archives can be restored manually while the server is stopped.

Default storage layout (all ignored by Git):

```text
data/
  server/       demo server files, or the default live server directory
  backups/      gzip-compressed tar archives
  databases/    SQLite files
  uploads/      temporary upload storage
  panel.json    schedules, backup metadata, access records, and audit events
  servers.json  server registry and saved configurations
  instances/
    <server-id>/
      server/       that server's Minecraft files
      backups/      that server's archives
      databases/    that server's SQLite files
      uploads/      that server's temporary uploads
      panel.json    that server's schedule, records, demo operators, and audit
```

`PANEL_DATA_DIR` changes the panel's data directory. Keep it outside a custom server directory so backups never archive themselves. Use only one API process per data directory. There is no background service installer; scheduling runs within the API process.

API clients can list/create servers at `/api/servers` and update one at `/api/servers/:id`. Select a server for existing APIs with the `X-Server-Id` header or the `serverId` query parameter for direct download links. Unknown IDs return 404; conflicting selectors return 400. Calls without either selector retain the original default server for backward compatibility.

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
