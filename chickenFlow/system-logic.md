# ChickenFlow System Logic Documentation

This document outlines the core functions, state management, and automated logic governing the ChickenFlow AI Coop Door system.

## 1. Architecture Overview
- **Type**: Local-only Demo/Testing Application.
- **Frontend**: Angular 21 with Signals for reactive state.
- **AI**: Integrated via Gemini API for real-time status analysis and anomaly detection.
- **Time Source**: Purely API-driven (Open-Meteo). All physical light sensor logic is removed to ensure reliability regardless of local ambient lighting conditions.

## 2. Core State Management (`CoopStateService`)

The system uses Angular Signals for reactive state management.

### Primary States:
- **`doorState`**: Enum (`OPEN`, `CLOSED`, `OPENING`, `CLOSING`, `ERROR`).
- **`serviceMode`**: Boolean. High-priority override. Includes a 4-hour "Abandonment Heartbeat" alarm.
- **`weatherLock`**: Boolean. AI-triggered lockdown for codes $\ge 65$ (Heavy Rain) or $\ge 82$ (Violent Showers).
- **`chickens`**: Array of `Chicken` objects tracking position (`x`, `y`) and status (`isInside`).

## 3. Automation Logic

### Solar Synchronization (`startTimeSync`)
- **Sunrise + Offset**: 
  - Automatically opens the door if `weatherLock` is inactive.
  - Activates Music Signal and Smart Entrance Light for 5 minutes.
- **Sunset - 1 Hour**:
  - Activates Music Signal and Smart Entrance Light for a 5-minute herding period.
- **Sunset - 55 Minutes (Herding Loop)**:
  - **Smart Mode**: 
    - If `insideCount` $\ge$ **80%**, the door closes.
    - If below 80%, re-initiates herding signal (music/light) for 5 minutes.
    - Cycle repeats up to **3 times**.
    - **Final Security Action**: If count remains below 80% after 3 attempts, the door closes for security. A "Flock Discrepancy" critical notification is logged.
- **Note**: This loop is paused when **Service Mode** is active.

### Smart Door Logic (`updateChickens`)
- The system monitors `insideCount`.
- When `insideCount === totalChickens`, the door transitions to `CLOSED` immediately.

### Weather Monitoring (`fetchWeather`)
- **Severe Weather (Codes $\ge 65, \ge 82$)**: Triggers `weatherLock`. Initiates emergency herding if the door is open.

## 4. Manual Overrides & Priority

### Door Open Override (`manualOpenOverride`)
- **Night-time Safety**: If engaged between Sunset and Sunrise, a **30-minute safety timer** starts.
- **Auto-Revert**: After 30 minutes, the door automatically closes and resets the toggle to OFF.
- **Service Mode Logic**: If **Service Mode** is active, the 30-minute timer is disabled. However, if Service Mode persists > 4 hours, a "Maintenance Abandonment" alert triggers.

### Manual Door Control (`setDoorState`)
- **Highest Priority**: Manual toggle always updates `doorState`.
- **Lockdown Override**: Opening manually during `weatherLock` clears the lockdown.

## 5. Safety Systems

### Obstruction Detection (Anti-Crush Protocol)
- Detected via **INA219 motor current stall pattern** (hardware) + **torque limiter** (mechanical safety).
- When the ESP32 detects a stall current during closing, the motor halts immediately and the AI vision gate (`/api/esp32/obstruction-check`) confirms via camera image.
- **Retry Sequence**: 
  - If triggered during closing, the door returns to `OPEN`.
  - Waits 30 seconds, then retries (Max 3 attempts).
- **Error State**: If 3 attempts fail, the door remains **OPEN**, enters `ERROR` state, and activates hardware alerts (Pulsing Red LED/Speaker).

## 6. Alert & Log Management
- **Retention**: Logs are capped at the **latest 200 entries** to maintain performance.
- **Pinning**: `ERROR`, `weatherLock`, and `serviceMode` alerts remain pinned until resolved.

## 7. AI Integration (Gemini API)
- **Status Analysis**: Periodic telemetry analysis.
- **Anomaly Detection**: Gemini flags irregular homing patterns (e.g., chickens taking longer than average to enter) to alert the user of potential illness or predators.