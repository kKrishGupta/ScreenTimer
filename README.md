# DigitalPulse

DigitalPulse is a lightweight, privacy-focused digital activity monitoring and productivity platform designed specifically for Windows 11.

It tracks application and website usage, maintains an activity timeline, and displays real usage metrics through a local web dashboard.

---

## Stage 1 Architecture

```
Windows 11
    |
    |-- Rust User Agent (dp-user-agent)
    |-- Chrome & Edge Extension (Manifest V3)
    |
    v
Local Fastify Backend (Node.js + Fastify + Prisma)
http://127.0.0.1:3001
    |
    v
Local PostgreSQL (127.0.0.1:5433)
    |
    v
React Dashboard (Vite + Tailwind CSS)
http://localhost:5173
```

---

## Getting Started

Refer to [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for detailed PowerShell setup and execution commands.
For architectural rationale, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

