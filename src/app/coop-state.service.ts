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
  isError: boolean;
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
  doorOpenTime = signal<string>('07:00');
  doorCloseTime = signal<string>('18:30');
  ir1 = signal<boolean>(false); // IR 1 (Interior)
  ir2 = signal<boolean>(false); // IR 2 (Exterior)
  private crossingSequence: ('ir1' | 'ir2')[] = [];
  systemOnline = signal<boolean>(true);
  ldrOnline = signal<boolean>(true);
  cameraOnline = signal<boolean>(true);
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
  serviceMode = signal<boolean>(false);
  manualOpenOverride = signal<boolean>(false);
  autoCloseTime = signal<string | null>(null);
  warningCount = signal<number>(0);
  errorCount = signal<number>(0);
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

  addStatusMessage(text: string, isWarning = false, isPinned = false, category?: string, isError = false) {
    const now = new Date();
    const newMessage: StatusMessage = {
      id: Math.random().toString(36).substring(2, 9),
      text,
      timestamp: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      date: now,
      isWarning,
      isError,
      isPinned,
      category
    };

    this.statusMessages.update(prev => {
      // If it's a weather lock or warning, pin it
      const updated = [newMessage, ...prev];
      return updated; // Removed slice limit to allow monthly logging
    });

    if (isWarning) {
      this.warningCount.update(c => c + 1);
    }
    if (isError) {
      this.errorCount.update(c => c + 1);
    }

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
      
      const currentSunrise = this.sunrise();
      const currentSunset = this.sunset();
      const openTime = this.doorOpenTime();
      const closeTime = this.doorCloseTime();

      // Calculate offsets for herding
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

      // --- MORNING LOGIC (Door Open Time) ---
      if (timeStr === openTime && this.doorState() === DoorState.CLOSED) {
        if (this.weatherLock()) {
          this.addStatusMessage(`Time is ${openTime}, but AI has locked the door due to severe weather.`, true, true);
        } else {
          this.setDoorState(DoorState.OPEN, false);
          this.musicSignal.set(true);
          this.smartNightLight.set(true);
          this.addStatusMessage("Morning routine: Door opened based on COOP CYCLE schedule.");
          
          // Turn off music after a short while (e.g. 5 mins)
          setTimeout(() => this.musicSignal.set(false), 300000);
        }
      }

      // --- EVENING LOGIC (Door Close Time) ---
      if (timeStr === closeTime && this.doorState() === DoorState.OPEN) {
        this.setDoorState(DoorState.CLOSED, false);
        this.addStatusMessage("Evening routine: Door reached scheduled closing time.");
      }

      // --- HERDING LOGIC (Sunset relative) ---
      if (timeStr === sunsetMinus1h) {
        if (!this.musicSignal()) {
          this.musicSignal.set(true);
          this.smartNightLight.set(true);
          this.addStatusMessage("Evening herding: Music signal and entrance light active.");
        }
      }

      if (timeStr === sunsetMinus55m) {
        if (this.doorState() === DoorState.OPEN && this.herdingAttempts === 0) {
          this.checkHerdingProgress();
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
        const sunriseTime = sr.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const sunsetTime = ss.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        
        this.sunrise.set(sunriseTime);
        this.sunset.set(sunsetTime);
        
        // Calculate Coop Cycle: Open +60m, Close +30m
        this.doorOpenTime.set(this.offsetTime(sunriseTime, 60));
        this.doorCloseTime.set(this.offsetTime(sunsetTime, 30));
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
      // Start with 20% inside
      const isInside = i < (count * 0.2);
      const x = isInside ? Math.random() * 90 + 20 : Math.random() * 100 + 150;
      const y = Math.random() * 100 + 65;
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
    const FRAME_X = 168; 
    const TUNNEL_LENGTH = 50; 
    const TUNNEL_X_START = FRAME_X; // Outside (Yard side starts here)
    const TUNNEL_X_END = TUNNEL_X_START + TUNNEL_LENGTH; // 218
    const TUNNEL_Y_CENTER = 102; // (70 + (64/2)) = 102
    const TUNNEL_HALF_HEIGHT = 32; // Full gap height (64/2)
    
    // Traffic Control: Track who is logically in the tunnel area
    // This allows simulating "one-by-one" passage
    const chickensInTunnel = this.chickens().filter(c => c.x >= TUNNEL_X_START && c.x <= TUNNEL_X_END).map(c => c.id);

    this.chickens.update(prev => {
      const next = prev.map(c => ({ ...c }));

      for (const c of next) {
        // 1. Determine Target Side occasionally
        if (currentState === DoorState.OPEN && Math.random() < 0.005) {
          c.isInside = !c.isInside;
        }

        // 2. Set Target Position based on side
        if (Math.random() < 0.02) { 
          if (currentState === DoorState.CLOSED || currentState === DoorState.ERROR) {
            if (c.x < FRAME_X) {
              c.targetX = Math.max(15, Math.min(FRAME_X - 25, c.targetX + (Math.random() - 0.5) * 80));
            } else {
              c.targetX = Math.max(TUNNEL_X_END + 25, Math.min(380, c.targetX + (Math.random() - 0.5) * 80));
            }
          } else {
            // Door open, targets can be anywhere
            c.targetX = Math.max(15, Math.min(380, c.targetX + (Math.random() - 0.5) * 120));
            
            // If they need to switch sides, guide them to the tunnel
            const targetSide = c.targetX < FRAME_X ? 'inside' : 'outside';
            const currentSide = c.x < FRAME_X ? 'inside' : 'outside';
            
            if (targetSide !== currentSide) {
              if (currentSide === 'inside') {
                c.targetX = TUNNEL_X_START + 5;
                c.targetY = TUNNEL_Y_CENTER;
              } else {
                c.targetX = TUNNEL_X_END - 5;
                c.targetY = TUNNEL_Y_CENTER;
              }
            }
          }
          c.targetY = Math.max(25, Math.min(165, c.targetY + (Math.random() - 0.5) * 100));
        }

        // 3. Move towards target
        let moveX = (c.targetX - c.x) * (0.03 + Math.random() * 0.03);
        const moveY = (c.targetY - c.y) * 0.04;

        // Tunnel Entry Constraint: One-by-one from Yard
        const isEntryAttempt = (c.x < TUNNEL_X_START && c.targetX >= TUNNEL_X_START) || 
                               (c.x > TUNNEL_X_END && c.targetX <= TUNNEL_X_END);
        
        // If tunnel is occupied and I'm not the one inside, wait
        const isOccupied = chickensInTunnel.length > 0 && !chickensInTunnel.includes(c.id);

        if (isEntryAttempt && isOccupied && currentState === DoorState.OPEN) {
          if (c.x < TUNNEL_X_START && c.x + moveX >= TUNNEL_X_START - 5) moveX = 0;
          if (c.x > TUNNEL_X_END && c.x + moveX <= TUNNEL_X_END + 5) moveX = 0;
        }

        let nextX = c.x + moveX;
        let nextY = c.y + moveY;

        // Environmental Collisions
        const inTunnelX = nextX >= TUNNEL_X_START && nextX <= TUNNEL_X_END;
        const inTunnelY = nextY >= TUNNEL_Y_CENTER - TUNNEL_HALF_HEIGHT && nextY <= TUNNEL_Y_CENTER + TUNNEL_HALF_HEIGHT;

        // Strict Middle Wall Boundary (Prevent entering the wall)
        // few extra pixels as requested
        const wallThickness = 12; 
        if (nextX >= FRAME_X - wallThickness && nextX <= FRAME_X + wallThickness) {
          if (currentState !== DoorState.OPEN || !inTunnelY) {
            // Hard stop and push back
            if (c.x < FRAME_X) {
              nextX = Math.min(c.x, FRAME_X - wallThickness);
            } else {
              nextX = Math.max(c.x, FRAME_X + wallThickness);
            }
          }
        }
        
        // Tunnel side walls (One-by-one lane)
        if (inTunnelX) {
           if (!inTunnelY) {
             nextY = c.y; 
           }
        }

        // IR Sensor Logic at Tunnel Front (Yard side) and Back (Coop side)
        // Back Sensor (ir2) = TUNNEL_X_START (153)
        // Front Sensor (ir1) = TUNNEL_X_END (203)
        if (currentState === DoorState.OPEN) {
           // Crossing Back Sensor (ir2)
           if (c.x < TUNNEL_X_START && nextX >= TUNNEL_X_START) {
              this.handleIRTrigger('ir2'); // Exiting coop: hit back sensor first
           } else if (c.x >= TUNNEL_X_START && nextX < TUNNEL_X_START) {
              this.handleIRTrigger('ir2'); // Entering coop: hit back sensor second
           }

           // Crossing Front Sensor (ir1)
           if (c.x > TUNNEL_X_END && nextX <= TUNNEL_X_END) {
              this.handleIRTrigger('ir1'); // Entering coop: hit front sensor first
           } else if (c.x <= TUNNEL_X_END && nextX > TUNNEL_X_END) {
              this.handleIRTrigger('ir1'); // Exiting coop: hit front sensor second
           }
        }

        // Boundaries
        if (nextX < 15) nextX = 15;
        if (nextX > 375) nextX = 375;
        if (nextY < 12) nextY = 12;
        if (nextY > 145) nextY = 145;

        c.x = nextX;
        c.y = nextY;
      }

      // Check for Automatic Door Closing (Smart Mode)
      const now = Date.now();
      const manualCooldown = 30000;
      if (currentState === DoorState.OPEN && (now - this.lastManualAction > manualCooldown)) {
        const insideCount = next.filter(c => c.x < 168).length;
        if (insideCount === next.length) {
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
      this.addStatusMessage("System Error: Door mechanism failure requested! Manual inspection required.", false, true, 'SYSTEM_ERROR', true);
      this.triggerErrorAlerts();
    } else {
      this.unpinCategory('SYSTEM_ERROR');
      this.stopErrorAlerts();
    }
    this.runAIAnalysis();
  }

  private handleIRTrigger(sensor: 'ir1' | 'ir2') {
    if (sensor === 'ir1') {
      this.ir1.set(true);
      setTimeout(() => this.ir1.set(false), 500);
    } else {
      this.ir2.set(true);
      setTimeout(() => this.ir2.set(false), 500);
    }

    this.crossingSequence.push(sensor);
    if (this.crossingSequence.length > 2) this.crossingSequence.shift();

    if (this.crossingSequence.length === 2) {
      const [first, second] = this.crossingSequence;
      if (first === 'ir2' && second === 'ir1') {
        // Entering (Yard to Coop)
        this.addStatusMessage("DUAL IR: Chicken entered coop.", false, false);
        this.crossingSequence = [];
      } else if (first === 'ir1' && second === 'ir2') {
        // Exiting (Coop to Yard)
        this.addStatusMessage("DUAL IR: Chicken exited coop.", false, false);
        this.crossingSequence = [];
      }
    }
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
    this.addStatusMessage(`Closing sequence initiated...`);

    // Simulate mechanism duration
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Simple random chance of physical jam or motor fault simulation (legacy error state)
    if (Math.random() < 0.05) {
      this.addStatusMessage(`DOOR ERROR: Motor torque limit exceeded!`, true, true, 'SYSTEM_ERROR', true);
      this.setDoorState(DoorState.ERROR, false);
    } else {
      this.doorState.set(DoorState.CLOSED);
      this.closeAttempts = 0;
      this.addStatusMessage("Door secured successfully.");
    }
  }

  manualChickenReturn() {
    this.isReturning.set(true);
    this.unpinCategory('HERDING');
    this.chickens.update(prev => prev.map(c => ({
      ...c,
      isInside: true,
      x: Math.random() * 90 + 20, // Move to coop area
      y: Math.random() * 100 + 65,
      targetX: Math.random() * 90 + 20,
      targetY: Math.random() * 100 + 65
    })));
    this.doorState.set(DoorState.CLOSED);
    this.lastManualAction = Date.now();
    this.addStatusMessage("Manual chicken return triggered. All chickens secured.", false, false);
    
    // Reset returning state after animation
    setTimeout(() => {
      this.isReturning.set(false);
    }, 3000);
  }

  async runAIAnalysis(context = "") {
    if (this.serviceMode()) return;
    this.isAnalyzing.set(true);
    this.warningCount.set(0);
    this.errorCount.set(0);
    try {
      const insideCount = this.chickens().filter(c => c.x < 128).length;
      const total = this.totalChickens();
      const weather = this.weatherForecast()[0];
      
      const prompt = `You are an AI Chicken Coop Manager with Dual IR Tracking.
      
      System Data:
      - Current Time: ${this.currentTime()}
      - Door State: ${this.doorState()}
      - Occupancy: ${insideCount}/${total} chickens inside
      - Weather: ${weather ? `${weather.temp}°C, code ${weather.code}` : 'Unknown'}
      - Lockdown: ${this.weatherLock() ? 'ACTIVE' : 'Inactive'}
      - Service Mode: ${this.serviceMode() ? 'ACTIVE' : 'Inactive'}
      - Context: ${context}
 
      Analysis Objectives:
      1. Security: At evening/night, identify if chickens are left outside.
      2. Logic Check: Report on Dual IR count consistency vs visual occupancy.

      Provide a concise status report with action recommendations. Max 40 words. Use markdown icons.`;

      const response = await this.ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt
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
