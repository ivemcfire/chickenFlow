#include <Arduino.h>
#include "config.h"
#include "music.h"

namespace {
  struct Note {
    uint32_t freqHz;
    uint16_t durationMs;
    uint16_t restMs;
  };

  static const Note GOT_THEME[] = {
    { NOTE_G4, 500, 50 },
    { NOTE_C4, 500, 50 },
    { NOTE_DS4, 250, 25 },
    { NOTE_F4, 250, 25 },

    { NOTE_G4, 500, 50 },
    { NOTE_C4, 500, 50 },
    { NOTE_E4, 250, 25 },
    { NOTE_F4, 250, 25 },

    { NOTE_G4, 500, 50 },
    { NOTE_C4, 500, 50 },
    { NOTE_DS4, 250, 25 },
    { NOTE_F4, 250, 25 },
    { NOTE_D4, 500, 100 },
  };

  constexpr size_t GOT_THEME_LENGTH = sizeof(GOT_THEME) / sizeof(GOT_THEME[0]);

  bool playingGoT = false;
  bool buzzerReadyInternal = false;
  size_t currentNoteIndex = 0;
  unsigned long notePhaseEndMs = 0;
  unsigned long themeEndMs = 0;
  bool noteIsPlaying = false;

  void stopTone() {
    ledcWriteTone(LEDC_BUZZER_CHANNEL, 0);
  }

  void advanceToNextNote(unsigned long now) {
    currentNoteIndex = (currentNoteIndex + 1) % GOT_THEME_LENGTH;
    noteIsPlaying = false;
    notePhaseEndMs = now;
  }

  void startCurrentNote(unsigned long now) {
    const Note& note = GOT_THEME[currentNoteIndex];
    if (note.freqHz > 0) {
      ledcWriteTone(LEDC_BUZZER_CHANNEL, note.freqHz);
      noteIsPlaying = true;
      notePhaseEndMs = now + note.durationMs;
    } else {
      noteIsPlaying = false;
      notePhaseEndMs = now + note.durationMs;
    }
  }
}

void buzzerInit() {
  ledcSetup(LEDC_BUZZER_CHANNEL, LEDC_BUZZER_FREQ_INIT, LEDC_BUZZER_RESOLUTION);
  ledcAttachPin(PIN_BUZZER, LEDC_BUZZER_CHANNEL);
  stopTone();
}

void setBuzzerReady(bool ready) {
  buzzerReadyInternal = ready;
  if (!ready) {
    stopTone();
    playingGoT = false;
  }
}

void musicTick() {
  if (!playingGoT || !buzzerReadyInternal) {
    return;
  }

  unsigned long now = millis();
  if (now >= themeEndMs) {
    stopTone();
    playingGoT = false;
    return;
  }

  if (!noteIsPlaying && notePhaseEndMs <= now) {
    startCurrentNote(now);
    return;
  }

  if (noteIsPlaying && now >= notePhaseEndMs) {
    stopTone();
    const Note& note = GOT_THEME[currentNoteIndex];
    if (note.restMs > 0) {
      noteIsPlaying = false;
      notePhaseEndMs = now + note.restMs;
    } else {
      advanceToNextNote(now);
    }
    return;
  }

  if (!noteIsPlaying && now >= notePhaseEndMs) {
    advanceToNextNote(now);
  }
}

void startGoTTheme(uint32_t durationMs) {
  if (!buzzerReadyInternal) {
    return;
  }

  playingGoT = true;
  currentNoteIndex = 0;
  noteIsPlaying = false;
  unsigned long now = millis();
  notePhaseEndMs = now;
  themeEndMs = now + durationMs;
  stopTone();
}

void buzzTone(uint32_t freqHz, uint32_t durationMs) {
  if (!buzzerReadyInternal) {
    return;
  }

  ledcWriteTone(LEDC_BUZZER_CHANNEL, freqHz);
  delay(durationMs);
  stopTone();
}

// 5 s threshold crossed — one short high chirp.
void playOverrideConfirm() {
  buzzTone(2500, 80);
}

// 10 s threshold crossed — two short high chirps (distinct from the
// single-chirp override tone).
void playServiceConfirm() {
  buzzTone(2500, 80);
  delay(80);
  buzzTone(2500, 80);
}

// Periodic reminder uses a lower pitch so it can't be mistaken for the
// service-mode-entry confirmation.
void playServiceReminder() {
  buzzTone(1800, 60);
  delay(80);
  buzzTone(1800, 60);
}
