# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**ChickenFlow** is an Angular 21 web application simulating an AI-powered automated chicken coop door. It integrates Google Gemini for anomaly detection and Open-Meteo for weather/solar data.

## Commands

All commands run from the `chickenFlow/` directory:

```bash
npm run dev        # Dev server on port 3000 (injects GEMINI_API_KEY from env)
npm run build      # Production build
npm run test       # Unit tests via Vitest
npm run lint       # ESLint on TypeScript and HTML files
npm run serve:ssr:app  # Run SSR Express server
```

To run a single test file:
```bash
npx vitest run src/path/to/file.spec.ts
```

**Required environment variable**: `GEMINI_API_KEY` must be set before running `npm run dev`.

## Architecture

The app is intentionally monolithic — a single root component (`App`) with all business logic in one service (`CoopStateService`). There are no child components.

### Key Files

- `src/app/app.ts` — Root component (OnPush), minimal logic, delegates to service
- `src/app/app.html` — Entire UI template
- `src/app/coop-state.service.ts` — All application state and automation logic (~750 lines)
- `src/app/app.config.ts` — Angular providers and app configuration
- `src/server.ts` — Express SSR server
- `system-logic.md` — Architecture documentation (read this for domain context)

### State Management

All state is managed via **Angular Signals** in `CoopStateService`. Key signals:

| Signal | Type | Purpose |
|--------|------|---------|
| `doorState` | enum | OPEN/CLOSED/OPENING/CLOSING/ERROR |
| `chickens[]` | array | Each chicken's x,y position and isInside flag |
| `weatherLock` | boolean | AI-triggered severe weather lockdown |
| `serviceMode` | boolean | Highest-priority manual override |
| `weatherForecast[]` | array | 5-day forecast from Open-Meteo |
| `sunrise`/`sunset` | string | Solar times (no physical light sensors) |
| `statusMessages[]` | array | System event log with pinned alerts |

State is persisted to `localStorage` under key `chickenflow_state` (synced hourly).

### Core Automation Logic

Three main automation loops in `CoopStateService`:

1. **Solar sync** (`startTimeSync`): Polls every second; triggers door open at sunrise+1h and herding at sunset-1h. Herding retries up to 3× at 5-min intervals if <80% of chickens are inside.

2. **Weather monitoring** (`fetchWeather`): Polls Open-Meteo; sets `weatherLock=true` for severe weather codes (≥65 rain, ≥82 showers, 95+ storms). Emergency herding triggered if door is open during lockdown.

3. **Obstruction detection**: Simulated via `distance` signal (ultrasonic sensor). On obstruction during close: reopen, wait 30s, retry (max 3 attempts), then enter ERROR state.

### AI Integration

`runAIAnalysis()` sends structured telemetry (time, door state, chicken positions, weather) to Gemini 2.0-flash-preview for anomaly detection. Triggered periodically and on significant state changes.

### Chicken Physics

An animation loop (~10fps) moves each chicken toward target positions. Door frame boundaries block passage when the door is closed. Collision detection prevents chickens overlapping.

## Tech Stack

- **Angular 21** with Signals (strict mode, OnPush everywhere)
- **Angular Material** + **Tailwind CSS v4**
- **Vitest** + jsdom for testing
- **Angular SSR** with Express v5
- **TypeScript 5.9** — strict mode, ES2022 target
