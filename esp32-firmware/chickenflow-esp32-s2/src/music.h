#pragma once

#include <Arduino.h>
#include "config.h"

constexpr uint32_t GOT_THEME_DURATION_MS = 300000u; // 5 minutes

void buzzerInit();
void setBuzzerReady(bool ready);
void musicTick();
void startGoTTheme(uint32_t durationMs = GOT_THEME_DURATION_MS);
void buzzTone(uint32_t freqHz, uint32_t durationMs);
