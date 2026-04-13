#pragma once
#include "esp_camera.h"
#include "config.h"

// ─────────────────────────────────────────────────────────────────────────────
// AI Thinker ESP32-CAM pin map
// ─────────────────────────────────────────────────────────────────────────────
#define CAM_PIN_PWDN    32
#define CAM_PIN_RESET   -1   // Software reset
#define CAM_PIN_XCLK     0
#define CAM_PIN_SIOD    26
#define CAM_PIN_SIOC    27
#define CAM_PIN_D7      35
#define CAM_PIN_D6      34
#define CAM_PIN_D5      39
#define CAM_PIN_D4      36
#define CAM_PIN_D3      21
#define CAM_PIN_D2      19
#define CAM_PIN_D1      18
#define CAM_PIN_D0       5
#define CAM_PIN_VSYNC   25
#define CAM_PIN_HREF    23
#define CAM_PIN_PCLK    22

bool cameraInit() {
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer   = LEDC_TIMER_0;
  config.pin_d0       = CAM_PIN_D0;
  config.pin_d1       = CAM_PIN_D1;
  config.pin_d2       = CAM_PIN_D2;
  config.pin_d3       = CAM_PIN_D3;
  config.pin_d4       = CAM_PIN_D4;
  config.pin_d5       = CAM_PIN_D5;
  config.pin_d6       = CAM_PIN_D6;
  config.pin_d7       = CAM_PIN_D7;
  config.pin_xclk     = CAM_PIN_XCLK;
  config.pin_pclk     = CAM_PIN_PCLK;
  config.pin_vsync    = CAM_PIN_VSYNC;
  config.pin_href     = CAM_PIN_HREF;
  config.pin_sccb_sda = CAM_PIN_SIOD;
  config.pin_sccb_scl = CAM_PIN_SIOC;
  config.pin_pwdn     = CAM_PIN_PWDN;
  config.pin_reset    = CAM_PIN_RESET;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  // PSRAM present on most AI Thinker modules — use larger frame buffer
  if (psramFound()) {
    config.frame_size   = FRAMESIZE_SVGA;  // 800×600 — sharp gives to 800px anyway
    config.jpeg_quality = 12;              // 0–63, lower = better quality
    config.fb_count     = 2;
  } else {
    config.frame_size   = FRAMESIZE_CIF;   // Fallback for boards without PSRAM
    config.jpeg_quality = 20;
    config.fb_count     = 1;
  }

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    DBGF("[Camera] Init failed: 0x%x\n", err);
    return false;
  }

  // Fine-tune sensor settings for a coop environment (low light tolerance)
  sensor_t *s = esp_camera_sensor_get();
  s->set_brightness(s, 1);       // -2 to 2
  s->set_contrast(s, 0);
  s->set_saturation(s, 0);
  s->set_special_effect(s, 0);   // 0=no effect
  s->set_whitebal(s, 1);         // AWB on
  s->set_awb_gain(s, 1);
  s->set_wb_mode(s, 0);          // Auto
  s->set_exposure_ctrl(s, 1);    // AEC on
  s->set_aec2(s, 1);             // AEC DSP
  s->set_gain_ctrl(s, 1);        // AGC on
  s->set_agc_gain(s, 0);
  s->set_gainceiling(s, (gainceiling_t)2);  // Up to 4x gain
  s->set_bpc(s, 0);
  s->set_wpc(s, 1);
  s->set_raw_gma(s, 1);
  s->set_lenc(s, 1);
  s->set_hmirror(s, 0);
  s->set_vflip(s, 0);
  s->set_dcw(s, 1);
  s->set_colorbar(s, 0);

  DBGLN("[Camera] Initialised OK");
  return true;
}
