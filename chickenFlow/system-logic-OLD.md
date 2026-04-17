# ChickenFlow System Logic Documentation

This document outlines the core functions, state management, and automated logic governing the ChickenFlow AI Coop Door system.

## 1. Architecture Overview
- **Type**: Local-only Demo/Testing Application.
- **Frontend**: Angular 21 with Signals for reactive state.
- **Backend/Database**: None. All state is managed in-memory within the `CoopStateService`.
- **AI**: Integrated via the Gemini API for real-time status analysis.

## 2. Core State Management (`CoopStateService`)

The system uses Angular Signals for reactive state management.

### Primary States:
- **`doorState`**: Enum (`OPEN`, `CLOSED`, `OPENING`, `CLOSING`, `ERROR`).
- **`serviceMode`**: Boolean. High-priority override that halts all automations.
- **`automaticDoor`**: Boolean. Enables AI-driven "Smart Mode" (closes when all chickens are detected) or "Simple Mode" (solar-based).
- **`weatherLock`**: Boolean. AI-triggered lockdown due to severe weather forecasts.
- **`chickens`**: Array of `Chicken` objects tracking position (`x`, `y`) and status (`isInside`).

## 2. Automation Logic

### Solar Synchronization (`startTimeSync`)
- **Sunrise + 1 Hour**: 
  - Automatically opens the door if `weatherLock` is inactive.
  - Simultaneously activates the **Music Signal** and **Smart Night-Light** (entrance illumination).
  - Music signal automatically deactivates after 5 minutes.
- **Sunset - 1 Hour**:
  - Activates the **Music Signal** and **Smart Night-Light** for a 5-minute herding period.
- **Sunset - 55 Minutes**:
  - Deactivates the **Music Signal**.
  - **Smart Mode**: 
    - Checks the chicken count. If at least **80%** are inside, the door closes.
    - If below 80%, the system re-initiates the herding signal (music/light) for another 5 minutes.
    - This cycle repeats up to **3 times**.
    - If after 3 attempts the count is still below 80%, the door is closed for security.
    - A critical notification is sent to the user and app: *"Only [percent]% of the chickens are back in the coop. Door is closed after 3 unsuccessful herding attempts!"*
  - **Simple Mode**: Closes the door immediately.
- **Note**: This loop is entirely paused when **Service Mode** is active. Sunrise and sunset times are fetched in real-time via the Open-Meteo API for the local area.

### Smart Door Logic (`updateChickens`)
- If `automaticDoor` is enabled and the door is `OPEN`, the system continuously monitors the `insideCount`.
- When `insideCount === totalChickens`, the door automatically transitions to `CLOSED`.

### Weather Monitoring (`fetchWeather`)
- Fetches real-time data from Open-Meteo.
- **Severe Weather (Codes 65, 82, etc.)**: Triggers `weatherLock`. If the door is open, it initiates emergency herding.
- **Adverse Weather (Codes > 60)**: Triggers standard herding to move chickens to safety.

## 3. Manual Overrides & Priority

### Manual Open Override (`manualOpenOverride`)
- **Decoupled Control**: The "Manual Open Override" toggle is independent of the current door state. It is off by default.
- **Daytime Behavior**: If engaged during the day, the door remains open until the standard sunset herding procedure begins.
- **Night-time Safety**: If engaged during the night (after sunset or before sunrise), the system initiates a **30-minute safety timer**.
  - The planned closing time is displayed in the app.
  - After 30 minutes, the door automatically closes to protect the flock.
  - A notification error is logged when this safety closure occurs.
- **Service Mode Supersedes**: If **Service Mode** is activated, all automatic safety timers and solar logic are disabled. The door remains in its current state indefinitely until manually changed.

### Manual Door Control (`setDoorState`)
- **Highest Priority**: Manual toggle always updates the `doorState` regardless of time or mode.
- **Lockdown Override**: Opening the door manually while `weatherLock` is active will clear the lockdown and return the system to the solar schedule.
- **Automatic Reset**: Any automatic closing action (sunset, night-time safety) will reset the `manualOpenOverride` toggle to its default OFF state.

### Service Mode Logic
- **Halt**: Pauses `startTimeSync`, `updateChickens` (animations and smart closing), and automated weather checks.
- **Manual Control**: In Service Mode, the door is strictly under manual control. No safety timers (including the 30-minute night override) will trigger.
- **UI Lockdown**: Disables "Automatic Door" toggle, "Refresh AI", and "Total Chickens" configuration to prevent logic conflicts.

## 4. Alert & Log Management

### Message Lifecycle
- **Pinning**: Critical alerts (Errors, Weather, Service Mode) are pinned to the top of the log.
- **Auto-Unpin**: Messages are unpinned when the triggering condition is resolved (e.g., Service Mode toggled OFF).
- **Archiving**: Old pinned messages (from previous days) are downgraded to regular logs.
- **Retention**: Logs are kept for **30 days** before being permanently discarded.

## 5. Safety Systems
- **Obstruction Detection**: Detected via INA219 motor current stall pattern + torque limiter, confirmed by AI vision gate.
- **Emergency Stop & Error Alerts**:
  - **Retry Sequence**: If an obstruction is detected during closing, the door will open and try to close automatically 3 times.
  - **Error State**: If not successful after 3 attempts, the system enters an `ERROR` state and halts.
  - **Hardware Alerts**:
    - **Speaker**: Plays a rapid alert sound (indicated by the pulsing red volume icon).
    - **Lighting**: The interior coop light flashes rapidly to signal an emergency.
    - **Notifications**: A push notification is provisioned and logged to the system as being sent to the owner's mobile device.
  - **Resolution**: Manual intervention or toggling the door state will reset the error and stop the hardware alerts.

## 6. AI Integration (Gemini API)
- **Status Analysis**: Periodically analyzes coop telemetry (time, weather, door state, chicken count) to provide natural language status reports.
- **Context Awareness**: The AI is aware of Service Mode and Weather Lockdown states.
