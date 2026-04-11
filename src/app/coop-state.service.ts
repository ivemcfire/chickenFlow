import { Injectable, signal } from '@angular/core';
import { GoogleGenAI } from "@google/genai";

export enum DoorState {
  OPEN = 'OPEN',
  CLOSED = 'CLOSED',
  OPENING = 'OPENING',
  CLOSING = 'CLOSING',
  ERROR = 'ERROR'
}

export interface Chicken {
  id: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  isInside: boolean;
  type: 'chick';
}

export interface WeatherDay {
  day: string;
  temp: number;
  code: number;
  icon: string;
}

export interface StatusMessage {
  id: string;
  text: string;
  timestamp: string;
  date: Date;
  isWarning: boolean;
  isPinned: boolean;
  category?: string;
}

@Injectable({
  providedIn: 'root'
})
export class CoopStateService {
  private ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  
  doorState = signal<DoorState>(DoorState.OPEN);
  chickens = signal<Chicken[]>([]);
  totalChickens = signal<number>(10);
  currentTime = signal<string>('');
  weatherForecast = signal<WeatherDay[]>([]);
  sunrise = signal<string>('06:00');
  sunset = signal<string>('18:00');
  distance = signal<number>(45); // Ultrasonic for obstruction
  irTriggered = signal<boolean>(false); // IR for counting
  systemOnline = signal<boolean>(true);
  statusMessages = signal<StatusMessage[]>([]);
  isAnalyzing = signal<boolean>(false);
  herdingMode = signal<boolean>(false);
  weatherLock = signal<boolean>(false);
  startTime = signal<string>(new Date().toLocaleString());
  
  solarTimer = signal<string>('--:--:--');
  solarTimerLabel = signal<string>('Solar Syncing');
  
  // Settings
  musicDuration = signal<number>(5);
  smartNightLight = signal<boolean>(true);
  musicSignal = signal<boolean>(false);
  isReturning = signal<boolean>(false);
  automaticDoor = signal<boolean>(true);
  serviceMode = signal<boolean>(false);
  manualOpenOverride = signal<boolean>(false);
  autoCloseTime = signal<string | null>(null);
  private lastManualAction = 0;
  private closeAttempts = 0;
  private herdingAttempts = 0;

  constructor() {
    this.loadState();
    this.initChickens();
    this.startAnimationLoop();
    this.startTimeSync();
    this.fetchWeather();
    this.addStatusMessage('System initialized. Syncing with solar cycles...', false, false);
    
    // Cleanup messages every hour (unpin old, discard > 30 days)
    setInterval(() => {
      this.cleanupMessages();
      this.saveState();
    }, 3600000);
  }

  private saveState() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const state = {
      totalChickens: this.totalChickens(),
      automaticDoor: this.automaticDoor(),
      serviceMode: this.serviceMode(),
      musicDuration: this.musicDuration(),
      smartNightLight: this.smartNightLight(),
      statusMessages: this.statusMessages()
    };
    localStorage.setItem('chickenflow_state', JSON.stringify(state));
  }

  private loadState() {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const saved = localStorage.getItem('chickenflow_state');
    if (saved) {
      try {
        const state = JSON.parse(saved);
        if (state.totalChickens) this.totalChickens.set(state.totalChickens);
        if (state.automaticDoor !== undefined) this.automaticDoor.set(state.automaticDoor);
        if (state.serviceMode !== undefined) this.serviceMode.set(state.serviceMode);
        if (state.musicDuration) this.musicDuration.set(state.musicDuration);
        if (state.smartNightLight !== undefined) this.smartNightLight.set(state.smartNightLight);
        if (state.statusMessages) {
          // Re-hydrate dates
          const messages = state.statusMessages.map((m: StatusMessage) => ({
            ...m,
            date: new Date(m.date)
          }));
          this.statusMessages.set(messages);
        }
      } catch (e) {
        console.error("Failed to load saved state", e);
      }
    }
  }

  addStatusMessage(text: string, isWarning = false, isPinned = false, category?: string) {
    const now = new Date();
    const newMessage: StatusMessage = {
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date: now,
      isWarning,
      isPinned,
      category
    };

    this.statusMessages.update(prev => {
      // If it's a weather lock or warning, pin it
      const updated = [newMessage, ...prev];
      return updated; // Removed slice limit to allow monthly logging
    });
    this.saveState();
  }

  unpinCategory(category: string) {
    this.statusMessages.update(messages => 
      messages.map(m => m.category === category ? { ...m, isPinned: false, isWarning: false } : m)
    );
  }

  private cleanupMessages() {
    const now = new Date();
    const today = now.toDateString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    this.statusMessages.update(messages => 
      messages
        .filter(m => m.date > thirtyDaysAgo) // Discard older than 30 days
        .map(m => {
          // If it's a pinned message from a previous day, unpin and downgrade to regular
          if (m.isPinned && m.date.toDateString() !== today) {
            return { ...m, isPinned: false, isWarning: false };
          }
          return m;
        })
    );
  }

  getDisplayMessages() {
    const all = this.statusMessages();
    const pinned = all.filter(m => m.isPinned).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    const unpinned = all.filter(m => !m.isPinned);
    
    // Return top 10 total
    return [...pinned, ...unpinned].slice(0, 10);
  }

  private startTimeSync() {
    const updateTime = () => {
      if (this.serviceMode()) return;

      const now = new Date();
      const timeStr = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
      this.currentTime.set(timeStr);
      
      const isAuto = this.automaticDoor();
      const currentSunrise = this.sunrise();
      const currentSunset = this.sunset();

      // Calculate offsets
      const sunrisePlus1h = this.offsetTime(currentSunrise, 60);
      const sunsetMinus1h = this.offsetTime(currentSunset, -60);
      const sunsetMinus55m = this.offsetTime(currentSunset, -55);

      // Calculate Solar Timer
      this.updateSolarTimer(now, currentSunrise, currentSunset);

      const sunriseDate = this.parseTime(currentSunrise, now);
      const sunsetDate = this.parseTime(currentSunset, now);
      const isNight = now < sunriseDate || now > sunsetDate;

      // --- NIGHT AUTO-CLOSE LOGIC ---
      if (this.manualOpenOverride() && !this.serviceMode()) {
        if (isNight) {
          if (!this.autoCloseTime()) {
            const closeDate = new Date(now.getTime() + 30 * 60000);
            this.autoCloseTime.set(closeDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
            this.addStatusMessage("Night-time manual override detected. Door will auto-close in 30 minutes for safety.", true, true, 'NIGHT_OVERRIDE');
          } else {
            const [h, m, s] = this.autoCloseTime()!.split(':').map(Number);
            const target = new Date(now);
            target.setHours(h, m, s, 0);
            
            if (now >= target) {
              this.setDoorState(DoorState.CLOSED, false);
              this.addStatusMessage("Night-time safety: Door automatically closed after 30-minute override.", true, true);
              this.autoCloseTime.set(null);
              this.unpinCategory('NIGHT_OVERRIDE');
            }
          }
        } else {
          if (this.autoCloseTime()) {
            this.autoCloseTime.set(null);
            this.unpinCategory('NIGHT_OVERRIDE');
          }
        }
      } else {
        if (this.autoCloseTime()) {
          this.autoCloseTime.set(null);
          this.unpinCategory('NIGHT_OVERRIDE');
        }
      }

      // --- MORNING LOGIC (Sunrise + 1h) ---
      if (timeStr === sunrisePlus1h && this.doorState() === DoorState.CLOSED) {
        if (this.weatherLock()) {
          this.addStatusMessage("Sunrise + 1h detected, but AI has locked the door due to severe weather.", true, true);
        } else {
          this.setDoorState(DoorState.OPEN, false);
          this.musicSignal.set(true);
          this.smartNightLight.set(true);
          this.addStatusMessage("Morning routine: Door opened, music signal active, entrance illuminated.");
          
          // Turn off music after a short while (e.g. 5 mins)
          setTimeout(() => this.musicSignal.set(false), 300000);
        }
      }

      // --- EVENING LOGIC (Sunset - 1h) ---
      if (timeStr === sunsetMinus1h) {
        if (!this.musicSignal()) {
          this.musicSignal.set(true);
          this.smartNightLight.set(true);
          this.addStatusMessage("Evening routine: Music signal and entrance light active for herding.");
        }
      }

      if (timeStr === sunsetMinus55m) {
        if (isAuto && this.doorState() === DoorState.OPEN && this.herdingAttempts === 0) {
          this.checkHerdingProgress();
        } else if (!isAuto && this.doorState() === DoorState.OPEN) {
          this.musicSignal.set(false);
          this.setDoorState(DoorState.CLOSED, false);
          this.addStatusMessage("Sunset routine (Simple Mode): Securing coop.");
        }
      }
    };
    updateTime();
    setInterval(updateTime, 1000); 
  }

  private async checkHerdingProgress() {
    if (this.serviceMode()) return;
    
    this.musicSignal.set(false);
    this.herdingAttempts++;
    
    const insideCount = this.chickens().filter(c => c.x < 176).length;
    const total = this.totalChickens();
    const probability = insideCount / total;
    const percent = Math.round(probability * 100);

    if (probability >= 0.8) {
      this.setDoorState(DoorState.CLOSED, false);
      this.addStatusMessage(`Sunset herding successful (${percent}% in). Securing coop.`);
      this.herdingAttempts = 0; 
    } else if (this.herdingAttempts < 3) {
      this.addStatusMessage(`Herding attempt ${this.herdingAttempts} failed: Only ${percent}% chickens inside. Retrying herding signal...`, true, true);
      
      // Re-trigger herding signal for another 5 mins
      this.musicSignal.set(true);
      this.smartNightLight.set(true);
      
      // Wait 5 minutes for next check (simulated)
      setTimeout(() => this.checkHerdingProgress(), 300000);
    } else {
      // 3 attempts failed
      this.setDoorState(DoorState.CLOSED, false);
      const msg = `Only ${percent}% of the chickens are back in the coop. Door is closed after 3 unsuccessful herding attempts!`;
      this.addStatusMessage(msg, true, true, 'HERDING_FAILURE');
      console.log("NOTIFICATION: " + msg);
      this.herdingAttempts = 0; 
    }
  }

  private offsetTime(timeStr: string, offsetMinutes: number): string {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    date.setMinutes(date.getMinutes() + offsetMinutes);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  }

  private updateSolarTimer(now: Date, sunriseStr: string, sunsetStr: string) {
    const sunriseDate = this.parseTime(sunriseStr, now);
    const sunsetDate = this.parseTime(sunsetStr, now);
    
    let targetDate: Date;
    let label: string;

    if (now < sunriseDate) {
      // It's night, before sunrise
      targetDate = sunriseDate;
      label = 'Time till door opens';
    } else if (now < sunsetDate) {
      // It's day, before sunset
      targetDate = sunsetDate;
      label = 'Time till door closing';
    } else {
      // It's night, after sunset
      const tomorrow = new Date(now);
      tomorrow.setDate(tomorrow.getDate() + 1);
      targetDate = this.parseTime(sunriseStr, tomorrow);
      label = 'Time till door opens';
    }

    this.solarTimerLabel.set(label);
    
    const diff = targetDate.getTime() - now.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    
    this.solarTimer.set(
      `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
    );
  }

  private parseTime(timeStr: string, baseDate: Date) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const d = new Date(baseDate);
    d.setHours(hours, minutes, 0, 0);
    return d;
  }

  private async fetchWeather() {
    try {
      // Using Open-Meteo with sunrise/sunset data
      const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=51.5074&longitude=-0.1278&daily=weathercode,temperature_2m_max,temperature_2m_min,sunrise,sunset&timezone=auto');
      const data = await res.json();
      
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const forecast = data.daily.time.map((t: string, i: number) => {
        const date = new Date(t);
        return {
          day: days[date.getDay()],
          temp: Math.round(data.daily.temperature_2m_max[i]),
          code: data.daily.weathercode[i],
          icon: this.getWeatherIcon(data.daily.weathercode[i])
        };
      }).slice(0, 5);
      
      this.weatherForecast.set(forecast);
      
      // Extract solar times for today
      if (data.daily.sunrise?.[0]) {
        const sr = new Date(data.daily.sunrise[0]);
        const ss = new Date(data.daily.sunset[0]);
        this.sunrise.set(sr.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
        this.sunset.set(ss.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }));
      }
      
      // Block automated weather responses in Service Mode
      if (this.serviceMode()) return;

      // AI check for bad weather
      const todayCode = data.daily.weathercode[0];
      
      // Severe weather check for lockdown (Snow, Thunderstorms, Heavy Rain)
      const severeCodes = [65, 82, 71, 73, 75, 77, 85, 86, 95, 96, 99];
      if (severeCodes.includes(todayCode)) {
        this.weatherLock.set(true);
        if (this.doorState() === DoorState.OPEN) {
          this.triggerHerding("Severe weather warning! AI is initiating emergency lockdown.");
        } else {
          this.addStatusMessage("Severe weather detected. AI has engaged Weather Lockdown for the day.", true, true, 'WEATHER_LOCK');
        }
      } else if (todayCode > 60 && this.doorState() === DoorState.OPEN) { 
        this.triggerHerding("Adverse weather detected. Herding chickens to safety.");
      }
    } catch (e) {
      console.error("Weather fetch failed", e);
      this.weatherForecast.set([
        { day: 'Mon', temp: 18, code: 0, icon: 'wb_sunny' },
        { day: 'Tue', temp: 16, code: 3, icon: 'cloud' },
        { day: 'Wed', temp: 14, code: 61, icon: 'water_drop' },
        { day: 'Thu', temp: 15, code: 3, icon: 'cloud' },
        { day: 'Fri', temp: 19, code: 0, icon: 'wb_sunny' }
      ]);
    }
  }

  private triggerHerding(reason: string) {
    this.herdingMode.set(true);
    this.musicSignal.set(true);
    this.smartNightLight.set(true);
    this.addStatusMessage(reason, true, true, 'HERDING');
    
    // In a real system, this would wait for sensors. 
    // Here we simulate the chickens moving in faster.
    this.manualChickenReturn();
  }

  private getWeatherIcon(code: number): string {
    if (code === 0) return 'wb_sunny';
    if (code < 4) return 'cloud_queue';
    if (code < 50) return 'cloud';
    if (code < 70) return 'water_drop';
    return 'thunderstorm';
  }

  private initChickens() {
    const initialChickens: Chicken[] = [];
    const count = this.totalChickens();
    for (let i = 0; i < count; i++) {
      // Start with 2 inside, 8 outside if total is 10 (20% inside)
      const isInside = i < (count * 0.2);
      const x = isInside ? Math.random() * 100 + 40 : Math.random() * 120 + 220;
      const y = Math.random() * 140 + 50;
      initialChickens.push({
        id: i,
        x,
        y,
        targetX: x,
        targetY: y,
        isInside,
        type: 'chick'
      });
    }
    this.chickens.set(initialChickens);
  }

  updateTotalChickens(count: number) {
    this.totalChickens.set(count);
    this.initChickens();
    this.saveState();
  }

  private startAnimationLoop() {
    setInterval(() => {
      this.updateChickens();
    }, 100); // Faster update for smoother movement
  }

  private updateChickens() {
    if (this.serviceMode()) return;
    
    const currentState = this.doorState();
    const CHICKEN_RADIUS = 10; 
    const FRAME_X_LEFT = 166;
    const FRAME_X_RIGHT = 178;
    const BUFFER = 14; // Radius (10) + margin (4)
    const SAFE_X_MIN = FRAME_X_LEFT - BUFFER;
    const SAFE_X_MAX = FRAME_X_RIGHT + BUFFER;
    const DOOR_Y_MIN = 80;
    const DOOR_Y_MAX = 160;

    this.chickens.update(prev => {
      const next = prev.map(c => ({ ...c }));

      for (let i = 0; i < next.length; i++) {
        const c = next[i];
        
        // 1. Determine Target Side occasionally
        if (currentState === DoorState.OPEN && Math.random() < 0.005) {
          c.isInside = !c.isInside;
        }

        // 2. Set Target Position based on side
        if (Math.random() < 0.02) { // Only pick new target occasionally
          if (currentState === DoorState.CLOSED || currentState === DoorState.ERROR) {
            if (c.x < 172) {
              c.targetX = Math.max(30, Math.min(SAFE_X_MIN - 5, c.targetX + (Math.random() - 0.5) * 80));
            } else {
              c.targetX = Math.max(SAFE_X_MAX + 5, Math.min(370, c.targetX + (Math.random() - 0.5) * 80));
            }
          } else {
            // Door open, targets can be anywhere but we'll bias them away from the frame
            c.targetX = Math.max(30, Math.min(370, c.targetX + (Math.random() - 0.5) * 100));
            // If target is in the frame X range, push it towards the opening or out
            if (c.targetX > SAFE_X_MIN && c.targetX < SAFE_X_MAX) {
               if (Math.random() < 0.6) { // 60% chance to push out of frame
                 c.targetX = (c.x < 172) ? SAFE_X_MIN - 10 : SAFE_X_MAX + 10;
               } else { // 40% chance to aim for the center of the door
                 c.targetY = 120; 
               }
            }
          }
          c.targetY = Math.max(45, Math.min(205, c.targetY + (Math.random() - 0.5) * 100));
        }

        // 3. Move towards target
        let moveX = (c.targetX - c.x) * 0.05;
        let moveY = (c.targetY - c.y) * 0.05;

        const nextX = c.x + moveX;
        const nextY = c.y + moveY;

        // Strict Boundary Check
        const inFrameX = nextX > SAFE_X_MIN && nextX < SAFE_X_MAX;
        const inOpeningY = nextY > DOOR_Y_MIN + 12 && nextY < DOOR_Y_MAX - 12;

        if (inFrameX) {
          if (currentState !== DoorState.OPEN || !inOpeningY) {
            // Blocked!
            moveX = 0;
            // If they are already "inside" the forbidden zone (e.g. from collision push), push them out
            if (c.x > SAFE_X_MIN && c.x < SAFE_X_MAX) {
               moveX = (c.x < 172) ? -1.5 : 1.5;
            }
            
            if (currentState === DoorState.OPEN) {
              // Guide towards center
              moveY = (nextY < 120) ? 1.5 : -1.5;
            }
          }
        }

        c.x += moveX;
        c.y += moveY;

        // 4. Realistic Bouncing (Collision)
        for (let j = 0; j < next.length; j++) {
          if (i === j) continue;
          const other = next[j];
          const dx = c.x - other.x;
          const dy = c.y - other.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const minDistance = CHICKEN_RADIUS * 2;

          if (dist < minDistance) {
            const angle = Math.atan2(dy, dx);
            const overlap = minDistance - dist;
            const force = overlap * 0.5;
            c.x += Math.cos(angle) * force;
            c.y += Math.sin(angle) * force;
            other.x -= Math.cos(angle) * force;
            other.y -= Math.sin(angle) * force;
          }
        }
      }

      // Check for Automatic Door Closing (Smart Mode)
      const now = Date.now();
      const manualCooldown = 30000; // 30 seconds cooldown after manual action
      if (this.automaticDoor() && currentState === DoorState.OPEN && (now - this.lastManualAction > manualCooldown)) {
        const insideCount = next.filter(c => c.x < 176).length;
        if (insideCount === next.length) {
          // All chickens are in!
          this.setDoorState(DoorState.CLOSED, false);
          this.addStatusMessage("All chickens are safely inside. Smart Door secured.");
        }
      }

      return next;
    });
  }

  async setDoorState(state: DoorState, isManual = true) {
    if (isManual) {
      this.lastManualAction = Date.now();
    } else {
      // If the system closes the door automatically, reset the manual toggle
      if (state === DoorState.CLOSED) {
        this.manualOpenOverride.set(false);
      }
    }

    if (state === DoorState.CLOSED) {
      this.initiateClosingSequence();
      return;
    }

    this.doorState.set(state);
    
    // Manual override clears weather lock
    if (state === DoorState.OPEN) {
      this.closeAttempts = 0; // Reset attempts on manual open
      if (this.weatherLock()) {
        this.weatherLock.set(false);
        this.unpinCategory('WEATHER_LOCK');
        this.addStatusMessage("Weather lockdown overridden by user. Returning to automatic solar schedule.", false, false);
      }
    }

    if (state === DoorState.ERROR) {
      this.distance.set(15); 
      this.addStatusMessage("System Error: Door obstruction detected after 3 attempts!", true, true, 'SYSTEM_ERROR');
      this.triggerErrorAlerts();
    } else {
      this.distance.set(45);
      this.unpinCategory('SYSTEM_ERROR');
      this.stopErrorAlerts();
    }
    this.runAIAnalysis();
  }

  toggleManualOpen() {
    const target = !this.manualOpenOverride();
    this.manualOpenOverride.set(target);
    if (target) {
      this.setDoorState(DoorState.OPEN, true);
    } else {
      this.setDoorState(DoorState.CLOSED, true);
    }
  }

  private triggerErrorAlerts() {
    // Provisioning notification
    console.log("NOTIFICATION: System Error - Door Obstruction. Sent to user: " + this.startTime());
    this.addStatusMessage("CRITICAL: Push notification sent to owner's mobile device.", true, false);
    
    // Activate hardware alerts
    this.musicSignal.set(true); // Alert sound on speaker
    this.smartNightLight.set(true); // Light will flash via CSS binding
  }

  private stopErrorAlerts() {
    // Reset alerts if we were in error
    if (this.doorState() !== DoorState.ERROR) {
      this.musicSignal.set(false);
    }
  }

  private async initiateClosingSequence() {
    this.doorState.set(DoorState.CLOSING);
    this.addStatusMessage(`Closing sequence initiated (Attempt ${this.closeAttempts + 1}/3)...`);

    // Simulate sensor check delay
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Check for obstruction (Simulated: 30% chance of obstruction if not already in error)
    // Or we can use the actual distance signal if we want to make it interactive
    const isObstructed = this.distance() < 20 || (Math.random() < 0.3 && this.closeAttempts < 3);

    if (isObstructed) {
      this.closeAttempts++;
      this.distance.set(15); // Show obstruction in UI
      this.addStatusMessage(`Obstruction detected! Re-opening door (Attempt ${this.closeAttempts}/3).`, true, false);
      
      this.doorState.set(DoorState.OPENING);
      await new Promise(resolve => setTimeout(resolve, 2000));
      this.doorState.set(DoorState.OPEN);
      this.distance.set(45); // Clear obstruction for next attempt

      if (this.closeAttempts < 3) {
        this.addStatusMessage(`Waiting for path to clear before retry...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        this.initiateClosingSequence();
      } else {
        this.setDoorState(DoorState.ERROR, false);
      }
    } else {
      this.doorState.set(DoorState.CLOSED);
      this.closeAttempts = 0;
      this.distance.set(45);
      this.addStatusMessage("Door secured successfully.");
    }
  }

  manualChickenReturn() {
    this.isReturning.set(true);
    this.unpinCategory('HERDING');
    this.chickens.update(prev => prev.map(c => ({
      ...c,
      isInside: true,
      x: Math.random() * 100 + 40, // Move to coop area
      y: Math.random() * 140 + 50,
      targetX: Math.random() * 100 + 40,
      targetY: Math.random() * 140 + 50
    })));
    this.doorState.set(DoorState.CLOSED);
    this.lastManualAction = Date.now();
    this.distance.set(45);
    this.irTriggered.set(false);
    this.addStatusMessage("Manual chicken return triggered. All chickens secured.", false, false);
    
    // Reset returning state after animation
    setTimeout(() => {
      this.isReturning.set(false);
    }, 3000);
  }

  async runAIAnalysis(context = "") {
    if (this.serviceMode()) return;
    this.isAnalyzing.set(true);
    try {
      const insideCount = this.chickens().filter(c => c.x < 176).length;
      const total = this.totalChickens();
      const weather = this.weatherForecast()[0];
      const prompt = `You are an AI Chicken Coop Manager. 
      Current Status:
      - Time: ${this.currentTime()}
      - Door: ${this.doorState()}
      - Chickens Inside: ${insideCount}/${total}
      - Weather: ${weather ? `${weather.temp}°C, code ${weather.code}` : 'Unknown'}
      - Weather Lockdown: ${this.weatherLock() ? 'ACTIVE' : 'Inactive'}
      - Service Mode: ${this.serviceMode() ? 'ACTIVE' : 'Inactive'}
      - Obstruction Distance: ${this.distance()}cm
      - Context: ${context}
      
      Provide a very brief, professional, and slightly witty status update (max 20 words). 
      If weather is bad (code > 60) or lockdown is active, mention safety measures.`;

      const response = await this.ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });

      const analysisText = response.text || "Analysis complete.";
      this.addStatusMessage(analysisText, this.weatherLock(), this.weatherLock());
    } catch (error) {
      console.error("AI Analysis failed", error);
      this.addStatusMessage("AI module offline. Manual monitoring advised.", true, true);
    } finally {
      this.isAnalyzing.set(false);
    }
  }
}
