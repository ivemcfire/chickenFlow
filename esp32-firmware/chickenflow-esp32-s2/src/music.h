#pragma once

#include <Arduino.h>
#include "config.h"

constexpr uint32_t GOT_THEME_DURATION_MS = 300000u; // 5 minutes

void buzzerInit();
void setBuzzerReady(bool ready);
void musicTick();
void startGoTTheme(uint32_t durationMs = GOT_THEME_DURATION_MS);
void buzzTone(uint32_t freqHz, uint32_t durationMs);

// Manual-button feedback (blocking; short enough for main loop jitter to be fine).
void playOverrideConfirm();    // One short chirp   — 5 s press threshold crossed.
void playServiceConfirm();     // Two short chirps  — 10 s press threshold crossed.
void playServiceReminder();    // Two lower chirps  — periodic "still in service mode".
