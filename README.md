# Minecraft Server UI

A local Minecraft server panel inspired by the navigation and console layout of Apollo. Built with React, TypeScript, Vite, and an Express API. Development work is on the `dev` branch.

## Run the panel

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

- **Console:** start, stop, restart, timestamped output, command entry, resource charts, and server status. In live mode commands go directly to the Java process's standard input, never to an operating system shell.
- **File Manager:** browse folders, create files and directories, edit text files up to 1 MB, delete files or folders, and upload/download original files. Upload up to 20 files per request, 256 MB per file. Existing names are protected from accidental upload overwrites. Paths and symbolic links are checked to keep operations inside the configured server directory.
- **Backups:** create and download real `.tar.gz` archives; configure interval, daily, or weekly schedules and retention. Manual backups are kept until deleted. Retention applies only to scheduled backups, after a new archive succeeds. Symbolic links are excluded.
- **Subusers:** store email and role records locally. These records do **not** create authenticated accounts, enforce permissions, or send invitations. All access to this local panel has administrator capabilities.
- **Databases:** create, download, and delete actual SQLite files. This is local SQLite storage, not a hosted MySQL service or automatic Minecraft plugin configuration.
- **Audit Logs:** persistent records of server commands, file changes, backup jobs, local access records, and database changes. The most recent 2,000 events are retained.

## Connect a real Java server

1. Copy `.env.example` to `.env`.
2. Set `MC_SERVER_DIR` to your existing Minecraft server directory, and `MC_SERVER_JAR` to the JAR filename inside that directory. Set `JAVA_PATH` if Java is not available on your PATH. Use the Java version required by your chosen server JAR.
3. Read and accept the [Minecraft EULA](https://aka.ms/MinecraftEULA) yourself, then set `eula=true` in the server's `eula.txt`.
4. Set `MC_MEMORY_MB` and the optional server display settings. Restart the panel and use **Start**.

Example configuration:

```dotenv
MC_SERVER_DIR=C:/Minecraft/survival
MC_SERVER_JAR=paper.jar
JAVA_PATH=C:/Program Files/Java/jdk-21/bin/java.exe
MC_MEMORY_MB=4096
MC_SERVER_NAME="Survival Server"
MC_SERVER_ADDRESS=localhost:25565
MC_SOFTWARE=Paper
MC_VERSION=1.21.4
```

The panel owns the Java process it launches. It cannot attach to an already running server. A normal panel shutdown sends `stop` and waits up to 15 seconds before terminating the process. The panel does not download JARs, change your EULA, or install plugins automatically. A custom `MC_SERVER_DIR` is never populated with demonstration files.

Live stdout, commands, power state, uptime, and disk usage work. Live CPU/memory telemetry and player querying are not yet connected; the API marks those readings unavailable rather than presenting simulated values as real measurements. Storage capacity is the host filesystem's capacity, not an enforced per-server quota. Memory allocation is enforced through the Java heap arguments. `MC_SERVER_ADDRESS`, version, software, and maximum player count are display configuration; change `server.properties` to alter the actual Minecraft server settings.

## Backup scheduling and data

Schedules use the **API host's local timezone**, included in the API response and schedule interface. The scheduler checks every 15 seconds and persists its next deadline in `data/panel.json`. Keep the API running for jobs to execute. After downtime, one overdue job runs on the next check; missed intervals are not replayed in a burst.

Online backups send `save-off` followed by `save-all flush`, then wait up to 15 seconds for the vanilla/Paper console to confirm that the game or world was saved. The archive is created while automatic world saving is paused. The panel sends `save-on` afterward, including failure paths. File changes, console commands, and power controls are blocked during a backup. If a save is not confirmed, no archive is created and the failure appears in Audit Logs. Unsupported server implementations can be backed up while stopped. Plugin-managed databases and files may still change independently; stop the server for a fully quiescent archive of those files.

A scheduled failure is recorded in Audit Logs and the job tries again at its next deadline. Backup restore is not implemented; downloaded archives can be restored manually while the server is stopped.

Default storage layout (all ignored by Git):

```text
data/
  server/       demo server files, or the default live server directory
  backups/      gzip-compressed tar archives
  databases/    SQLite files
  uploads/      temporary upload storage
  panel.json    schedules, backup metadata, access records, and audit events
```

`PANEL_DATA_DIR` changes the panel's data directory. Keep it outside a custom server directory so backups never archive themselves. Use only one API process per data directory. There is no background service installer; scheduling runs within the API process.

## Local access boundary

The server and development frontend bind to `127.0.0.1`. The API rejects nonlocal Host headers and cross-site mutation requests. This initial version has no login or network authorization, so do not expose it through a public reverse proxy or tunnel. Remote hosting and real role enforcement require authentication before deployment.

## Verify

```sh
npm test
npm run build
```

Integration tests exercise original-byte uploads/downloads, editing and deletion, path traversal and symlink rejection, request-origin checks, readable backup archives, persistence and retention, missed schedule handling, SQLite validity, access records, simulated console controls, and online Java backup coordination with a stub process. Tests use isolated temporary directories and do not touch your server data.

Browser integration tests cover the console, file editor and transfers, backup downloads and schedules, local access records, SQLite downloads, audit filtering, and mobile layouts:

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

The browser suite starts an isolated backend on port 3111 and removes its temporary data afterward. To use an already installed Chrome instead of downloading Chromium, set `PLAYWRIGHT_CHANNEL=chrome` in your shell. A real Minecraft JAR has not been tested as part of this initial development build; live-process integration is covered with a controlled process stub.
