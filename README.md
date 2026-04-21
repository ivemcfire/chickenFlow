# ChickenFlow

An industrial-grade, highly reliable automated chicken coop door controller built on the ESP32-S2 Mini. ChickenFlow is designed to handle high-torque mechanical loads safely while operating efficiently off a split-power architecture.

## Architecture Overview

This system utilizes a split-power design to optimize efficiency and safety. The ESP32 and logic sensors are powered continuously by the 5V standby rail of an Xbox 360 power supply. The high-current 12V rail remains in standby mode until the door needs to move or a critical error requires the visual warning lamp. The ESP32 wakes the 12V rail via an optocoupler isolation circuit.

## Key Features

* High-Torque Motor Control: Drives a 12V hand drill motor via a 43A BTS7960 H-Bridge, providing immense lifting power with active motor braking to prevent gravity drops.
* Bulletproof Safety Protocols:
  * Active Stall Detection: An INA219 sensor monitors current draw to stop the motor instantly upon mechanical obstruction.
  * Physical Limits: Top and bottom limit switches prevent mechanical over-travel.
  * Visual and Audio Alarms: An XY-MOS driven 12V warning lamp and a dedicated buzzer alert operators to stalls or manual service modes.
* Autonomous Solar Fallback: A DS3231 RTC and Dusk2Dawn logic ensure the door operates reliably based on local sunrise and sunset times, even if the Wi-Fi or MQTT broker goes offline.
* Non-Blocking Firmware: Built in C++ via PlatformIO, utilizing a rigorous non-blocking state machine to guarantee MQTT responsiveness and rapid safety intervention.

## Hardware Stack

* Microcontroller: ESP32-S2 Mini (lolin_s2_mini)
* Power Supply: 150W Xbox 360 PSU (12.1A)
* Motor Driver: BTS7960 (43A H-Bridge)
* Logic Step-Down: HW-1338 Buck Converter (5V to 3.3V)
* Sensors: INA219 (Current), HW-084 / DS3231 (RTC), IR Break Beams, Mechanical Limit Switches
* Wake Circuit: PC817 Optocoupler
* Auxiliary Control: XY-MOS Dual FET Module (for 12V warning lamp)

## Software and Deployment

* Environment: PlatformIO
* Transport: MQTT with JSON payloads
* Configuration: Operational parameters (stall thresholds, travel times, coordinates) are saved to NVS via retained MQTT messages for seamless over-the-air updates.

## Quick Start Guide

1. Clone this repository to your local machine.
2. Review the comprehensive wiring documentation located in docs/wiring.md.
3. Open the project in VS Code using the PlatformIO extension.
4. Run a clean build to fetch dependencies and apply the custom patch_dusk2dawn.py pre-build script.
5. Flash the firmware to your ESP32-S2 Mini via USB.
6. Trigger an initial MQTT retained configuration payload from your backend.
7. Calibrate the INA219 stall threshold on your test bench before final installation.
