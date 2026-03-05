# Calendar Filter — Docker Setup

A self-hosted web app for filtering Google Calendar exports, calculating
stipends, and exporting monthly summaries to Excel. Data lives on the server
so it's shared across all your devices (phone, laptop, desktop) on your
home network.

---

## Requirements

- [Docker](https://docs.docker.com/get-docker/) + Docker Compose
  (Docker Desktop installs both on Mac/Windows; on Linux install `docker-ce` and `docker compose`)

---

## First-time setup

```bash
# 1. Clone or copy this folder to your server / always-on machine
cd calfilter

# 2. Build and start
docker compose up -d --build

# 3. Open in your browser
open http://localhost:3000
```

From any other device on your home network, replace `localhost` with the
server's local IP address, e.g. `http://192.168.1.50:3000`.

> **Finding your server's IP:**
> - macOS/Linux: `ip addr` or `ifconfig`
> - Windows: `ipconfig`
> - Most routers also list connected devices with their IPs in the admin panel.

---

## Updating the app

Your data is stored in a Docker volume (`calfilter-data`) that is **separate
from the container**. Rebuilding or replacing the container never touches it.

```bash
# Pull latest code changes, then rebuild
docker compose up -d --build
```

That's it. The database survives the update untouched.

---

## Backup your data

The SQLite database is in a Docker volume. To back it up:

```bash
# Copy the database file out of the volume to your current directory
docker run --rm \
  -v calfilter_calfilter-data:/data \
  -v $(pwd):/backup \
  alpine \
  cp /data/calfilter.db /backup/calfilter-backup.db
```

To restore from a backup:

```bash
docker run --rm \
  -v calfilter_calfilter-data:/data \
  -v $(pwd):/backup \
  alpine \
  cp /backup/calfilter-backup.db /data/calfilter.db
```

---

## Changing the port

Edit `docker-compose.yml` and change the left side of the ports mapping:

```yaml
ports:
  - "8080:3000"   # Now accessible at http://your-server:8080
```

Then restart:

```bash
docker compose up -d
```

---

## Stopping and starting

```bash
docker compose stop      # Stop without removing data
docker compose start     # Start again
docker compose down      # Stop and remove container (data volume kept)
docker compose down -v   # ⚠️  DELETES DATA VOLUME — use with caution
```

---

## Logs

```bash
docker compose logs -f calfilter
```

---

## Project structure

```
calfilter/
├── Dockerfile              # Multi-stage build (React → Node)
├── docker-compose.yml      # One-command deployment
├── README.md
├── server/
│   ├── index.js            # Express API + SQLite
│   └── package.json
└── client/
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        └── App.jsx         # Main React application
```

## API endpoints (for reference)

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/events | Get all events |
| POST | /api/events/merge | Upsert a batch of events |
| DELETE | /api/events | Delete all events |
| GET | /api/settings | Get all settings |
| PUT | /api/settings/:key | Set a setting |
| DELETE | /api/settings/:key | Delete a setting |
| DELETE | /api/all | Wipe everything |
