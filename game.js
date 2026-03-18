// ============================================
// SUPER DASH BROS — Client Game
// Geometry Dash-inspired browser game
// ============================================
(function () {
    "use strict";

    // ============================================
    // CONFIG
    // ============================================
    const CFG = {
        WIDTH: 1280,
        HEIGHT: 720,
        GROUND_Y: 580,
        PLAYER_X: 200,
        PLAYER_SIZE: 44,
        GRAVITY: 0.65,
        JUMP_FORCE: -12.5,
        BASE_SPEED: 6,
        MAX_SPEED: 12,
        SPEED_RAMP: 0.0003, // speed increase per frame
        LEVEL_LENGTH: 12000, // pixels
        JUMP_BUFFER_MS: 100,
        COYOTE_MS: 80,
        GHOST_SAMPLE_HZ: 10,
        PARTICLE_POOL: 200,
        SEGMENT_WIDTH: 400,
    };

    // ============================================
    // CANVAS + SCALING
    // ============================================
    const canvas = document.getElementById("game-canvas");
    const ctx = canvas.getContext("2d");
    let scale = 1, offsetX = 0, offsetY = 0;

    function resize() {
        const w = window.innerWidth, h = window.innerHeight;
        canvas.width = w;
        canvas.height = h;
        const sx = w / CFG.WIDTH, sy = h / CFG.HEIGHT;
        scale = Math.min(sx, sy);
        offsetX = (w - CFG.WIDTH * scale) / 2;
        offsetY = (h - CFG.HEIGHT * scale) / 2;
        // Landscape hint for mobile
        const hint = document.getElementById("landscape-hint");
        if (isMobile && w < h) hint.classList.remove("hidden");
        else hint.classList.add("hidden");
    }
    window.addEventListener("resize", resize);

    // ============================================
    // STATE
    // ============================================
    let gameState = "menu"; // menu, playing, dead, win, countdown, multiplayer
    let selectedChar = "k1";
    let attempt = 1;
    let gameTime = 0;
    let seed = 0;
    let scrollX = 0;
    let speed = CFG.BASE_SPEED;
    let isMobile = false;
    let bestTime = null;

    // Shake
    let shakeAmount = 0, shakeDuration = 0;

    // Player
    let player = null;

    // Level
    let obstacles = [];
    let platforms = [];
    let decorations = [];

    // Ghost
    let ghostRecording = null;
    let ghostFrames = [];
    let localGhostCache = null;
    let globalGhost = null;

    // Multiplayer
    let ws = null;
    let mpState = null; // { room, myIndex, remotePlayers: [] }

    // ============================================
    // ASSETS
    // ============================================
    const sprites = {};
    const spriteNames = ["k1-right", "k2-right"];
    let spritesLoaded = 0;

    function loadSprites() {
        spriteNames.forEach((name) => {
            const img = new Image();
            img.onload = () => { spritesLoaded++; };
            img.src = name + ".png";
            sprites[name] = img;
        });
    }

    const bgImg = new Image();
    bgImg.src = "top.jpg";

    loadSprites();

    // ============================================
    // SFX SYSTEM (adapted from shooting)
    // ============================================
    const SFX = {
        ctx: null,
        muted: false,
        _ensureCtx() {
            if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
            if (this.ctx.state === "suspended") this.ctx.resume();
            return this.ctx;
        },
        _osc(type, freq, endFreq, dur, vol) {
            if (this.muted) return;
            const c = this._ensureCtx();
            const o = c.createOscillator(), g = c.createGain();
            o.type = type;
            o.frequency.setValueAtTime(freq, c.currentTime);
            if (endFreq !== freq) o.frequency.linearRampToValueAtTime(endFreq, c.currentTime + dur);
            g.gain.setValueAtTime(vol || 0.15, c.currentTime);
            g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
            o.connect(g).connect(c.destination);
            o.start(); o.stop(c.currentTime + dur);
        },
        _noise(dur, vol, filterFreq) {
            if (this.muted) return;
            const c = this._ensureCtx();
            const len = c.sampleRate * dur;
            const buf = c.createBuffer(1, len, c.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
            const src = c.createBufferSource();
            src.buffer = buf;
            const g = c.createGain();
            g.gain.setValueAtTime(vol || 0.1, c.currentTime);
            g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
            if (filterFreq) {
                const f = c.createBiquadFilter();
                f.type = "lowpass"; f.frequency.value = filterFreq;
                src.connect(f).connect(g).connect(c.destination);
            } else {
                src.connect(g).connect(c.destination);
            }
            src.start(); src.stop(c.currentTime + dur);
        },
        jump() {
            this._osc("sine", 400, 600, 0.08, 0.08);
        },
        land() {
            this._osc("triangle", 150, 80, 0.05, 0.05);
        },
        death() {
            this._noise(0.3, 0.15, 600);
            this._osc("sawtooth", 200, 50, 0.3, 0.12);
        },
        win() {
            if (this.muted) return;
            const c = this._ensureCtx();
            [523, 659, 784, 1047].forEach((freq, i) => {
                const o = c.createOscillator(), g = c.createGain();
                o.type = "sine"; o.frequency.value = freq;
                const t = c.currentTime + i * 0.1;
                g.gain.setValueAtTime(0.1, t);
                g.gain.linearRampToValueAtTime(0, t + 0.2);
                o.connect(g).connect(c.destination);
                o.start(t); o.stop(t + 0.2);
            });
        },
        click() { this._osc("sine", 660, 660, 0.04, 0.06); },
        countdown() { this._osc("square", 440, 440, 0.1, 0.08); },
        countdownGo() { this._osc("square", 880, 880, 0.2, 0.1); },
        toggleMute() {
            this.muted = !this.muted;
            const btn = document.getElementById("btn-mute");
            btn.textContent = this.muted ? "✕" : "♪";
            btn.classList.toggle("muted", this.muted);
        },
    };

    // ============================================
    // OBJECT POOL
    // ============================================
    class Pool {
        constructor(factory, size) {
            this.pool = [];
            this.active = [];
            for (let i = 0; i < size; i++) this.pool.push(factory());
            this.factory = factory;
        }
        get() {
            const obj = this.pool.pop() || this.factory();
            this.active.push(obj);
            return obj;
        }
        release(obj) {
            const idx = this.active.indexOf(obj);
            if (idx !== -1) { this.active.splice(idx, 1); this.pool.push(obj); }
        }
        releaseAll() { while (this.active.length) this.pool.push(this.active.pop()); }
        forEach(fn) { for (let i = this.active.length - 1; i >= 0; i--) fn(this.active[i], i); }
        get count() { return this.active.length; }
    }

    // ============================================
    // PARTICLES
    // ============================================
    const particles = new Pool(() => ({
        x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 2, color: "#fff",
    }), CFG.PARTICLE_POOL);

    function spawnParticles(x, y, count, color, spd, life, size) {
        for (let i = 0; i < count; i++) {
            const p = particles.get();
            const angle = Math.random() * Math.PI * 2;
            const s = (Math.random() * 0.7 + 0.3) * spd;
            p.x = x; p.y = y;
            p.vx = Math.cos(angle) * s;
            p.vy = Math.sin(angle) * s;
            p.life = life || 20 + Math.random() * 20;
            p.maxLife = p.life;
            p.size = size || 1.5 + Math.random() * 2.5;
            p.color = color;
        }
    }

    function spawnDeathExplosion(x, y) {
        spawnParticles(x, y, 30, "#ff3366", 5, 35, 3);
        spawnParticles(x, y, 20, "#ff8800", 3.5, 25, 2);
        spawnParticles(x, y, 10, "#fff", 6, 15, 1.5);
    }

    function spawnJumpParticles(x, y) {
        spawnParticles(x, y + CFG.PLAYER_SIZE / 2, 5, "#00d4ff", 2, 15, 2);
    }

    function spawnTrailParticle(x, y) {
        const p = particles.get();
        p.x = x - 5 + Math.random() * 10;
        p.y = y + Math.random() * CFG.PLAYER_SIZE;
        p.vx = -speed * 0.3;
        p.vy = (Math.random() - 0.5) * 0.5;
        p.life = 10 + Math.random() * 10;
        p.maxLife = p.life;
        p.size = 1 + Math.random() * 2;
        p.color = selectedChar === "k1" ? "#00d4ff" : "#ff44aa";
    }

    function updateParticles() {
        particles.forEach((p) => {
            p.x += p.vx; p.y += p.vy;
            p.vx *= 0.97; p.vy *= 0.97;
            p.life--;
            if (p.life <= 0) particles.release(p);
        });
    }

    function drawParticles() {
        particles.forEach((p) => {
            const alpha = p.life / p.maxLife;
            ctx.globalAlpha = alpha;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
            ctx.fill();
        });
        ctx.globalAlpha = 1;
    }

    // ============================================
    // SEEDED PRNG (LCG)
    // ============================================
    function createPRNG(s) {
        let state = s;
        return function () {
            state = (state * 1664525 + 1013904223) & 0x7fffffff;
            return state / 0x7fffffff;
        };
    }

    // ============================================
    // LEVEL GENERATION
    // ============================================
    function generateLevel(levelSeed) {
        const rng = createPRNG(levelSeed);
        obstacles = [];
        platforms = [];
        decorations = [];

        const segmentCount = Math.floor(CFG.LEVEL_LENGTH / CFG.SEGMENT_WIDTH);
        let lastGapEnd = 0;

        for (let seg = 0; seg < segmentCount; seg++) {
            const sx = seg * CFG.SEGMENT_WIDTH + 600; // offset from start
            const difficulty = Math.min(seg / segmentCount, 1); // 0 to 1
            const r = rng();

            if (seg < 2) {
                // Easy start: small spikes only
                if (r > 0.4) {
                    const count = 1 + Math.floor(rng() * 2);
                    for (let i = 0; i < count; i++) {
                        obstacles.push({
                            type: "spike",
                            x: sx + i * 50 + rng() * 60,
                            y: CFG.GROUND_Y - 30,
                            w: 30,
                            h: 30,
                        });
                    }
                }
                continue;
            }

            if (r < 0.25) {
                // Spikes cluster
                const count = 1 + Math.floor(rng() * (2 + difficulty * 3));
                const spacing = 35 + rng() * 20;
                for (let i = 0; i < count; i++) {
                    obstacles.push({
                        type: "spike",
                        x: sx + i * spacing,
                        y: CFG.GROUND_Y - 30,
                        w: 30,
                        h: 30,
                    });
                }
            } else if (r < 0.45) {
                // Gap
                const gapW = 80 + rng() * (60 + difficulty * 80);
                if (sx - lastGapEnd > 300) {
                    obstacles.push({
                        type: "gap",
                        x: sx,
                        y: CFG.GROUND_Y,
                        w: gapW,
                        h: 200,
                    });
                    lastGapEnd = sx + gapW;
                }
            } else if (r < 0.6) {
                // Pillar
                const pillarH = 60 + rng() * (80 + difficulty * 60);
                obstacles.push({
                    type: "pillar",
                    x: sx,
                    y: CFG.GROUND_Y - pillarH,
                    w: 40,
                    h: pillarH,
                });
            } else if (r < 0.75) {
                // Sawblade
                obstacles.push({
                    type: "saw",
                    x: sx,
                    y: CFG.GROUND_Y - 60 - rng() * (40 + difficulty * 60),
                    w: 44,
                    h: 44,
                });
            } else if (r < 0.88) {
                // Platform with spike on top
                const pw = 80 + rng() * 80;
                const ph = 16;
                const py = CFG.GROUND_Y - 80 - rng() * 80;
                platforms.push({ x: sx, y: py, w: pw, h: ph });
                if (difficulty > 0.3 && rng() > 0.5) {
                    obstacles.push({
                        type: "spike",
                        x: sx + pw / 2 - 15,
                        y: py - 30,
                        w: 30,
                        h: 30,
                    });
                }
            } else {
                // Double spike + gap combo (hard)
                if (difficulty > 0.4) {
                    obstacles.push({ type: "spike", x: sx, y: CFG.GROUND_Y - 30, w: 30, h: 30 });
                    obstacles.push({ type: "spike", x: sx + 40, y: CFG.GROUND_Y - 30, w: 30, h: 30 });
                    if (sx - lastGapEnd > 300) {
                        obstacles.push({ type: "gap", x: sx + 100, y: CFG.GROUND_Y, w: 80 + rng() * 40, h: 200 });
                        lastGapEnd = sx + 100 + 80;
                    }
                } else {
                    obstacles.push({ type: "spike", x: sx, y: CFG.GROUND_Y - 30, w: 30, h: 30 });
                }
            }

            // Decorations (background stars/lines)
            if (rng() > 0.6) {
                decorations.push({
                    x: sx + rng() * CFG.SEGMENT_WIDTH,
                    y: 100 + rng() * 300,
                    size: 1 + rng() * 2,
                    alpha: 0.1 + rng() * 0.3,
                });
            }
        }
    }

    // ============================================
    // PLAYER
    // ============================================
    function createPlayer() {
        return {
            x: CFG.PLAYER_X,
            y: CFG.GROUND_Y - CFG.PLAYER_SIZE,
            vy: 0,
            grounded: true,
            alive: true,
            rotation: 0,
            jumpBufferTimer: 0,
            coyoteTimer: CFG.COYOTE_MS,
            wasGrounded: true,
        };
    }

    function playerJump() {
        if (!player || !player.alive) return;
        if (player.grounded || player.coyoteTimer > 0) {
            player.vy = CFG.JUMP_FORCE;
            player.grounded = false;
            player.coyoteTimer = 0;
            player.jumpBufferTimer = 0;
            SFX.jump();
            spawnJumpParticles(player.x, player.y + CFG.PLAYER_SIZE);
            if (ws && mpState) {
                ws.send(JSON.stringify({ type: "player_jump" }));
            }
        } else {
            player.jumpBufferTimer = CFG.JUMP_BUFFER_MS;
        }
    }

    function updatePlayer(dt) {
        if (!player || !player.alive) return;

        // Gravity
        player.vy += CFG.GRAVITY;
        player.y += player.vy;

        // Timers
        if (player.jumpBufferTimer > 0) player.jumpBufferTimer -= dt;
        if (!player.grounded) {
            if (player.wasGrounded) player.coyoteTimer = CFG.COYOTE_MS;
            else if (player.coyoteTimer > 0) player.coyoteTimer -= dt;
        }

        // Ground collision
        player.grounded = false;
        player.wasGrounded = false;

        // Check if over a gap
        let overGap = false;
        for (const ob of obstacles) {
            if (ob.type === "gap") {
                const ox = ob.x - scrollX;
                if (player.x + CFG.PLAYER_SIZE > ox + 8 && player.x < ox + ob.w - 8) {
                    overGap = true;
                    break;
                }
            }
        }

        if (!overGap && player.y >= CFG.GROUND_Y - CFG.PLAYER_SIZE) {
            player.y = CFG.GROUND_Y - CFG.PLAYER_SIZE;
            player.vy = 0;
            player.grounded = true;
            player.wasGrounded = true;
            player.coyoteTimer = CFG.COYOTE_MS;
        }

        // Platform collision
        for (const plat of platforms) {
            const px = plat.x - scrollX;
            if (
                player.vy >= 0 &&
                player.x + CFG.PLAYER_SIZE > px &&
                player.x < px + plat.w &&
                player.y + CFG.PLAYER_SIZE >= plat.y &&
                player.y + CFG.PLAYER_SIZE <= plat.y + plat.h + 10
            ) {
                player.y = plat.y - CFG.PLAYER_SIZE;
                player.vy = 0;
                player.grounded = true;
                player.wasGrounded = true;
                player.coyoteTimer = CFG.COYOTE_MS;
            }
        }

        // Jump buffer
        if (player.grounded && player.jumpBufferTimer > 0) {
            playerJump();
        }

        // Rotation (visual spin when airborne like Geometry Dash)
        if (!player.grounded) {
            player.rotation += 5;
        } else {
            // Snap to nearest 90 degrees
            player.rotation = Math.round(player.rotation / 90) * 90;
        }

        // Fell off screen
        if (player.y > CFG.HEIGHT + 100) {
            killPlayer();
        }

        // Collision with obstacles
        checkCollisions();
    }

    function checkCollisions() {
        const ps = CFG.PLAYER_SIZE;
        const hitShrink = 6; // Slightly forgiving hitbox
        const px1 = player.x + hitShrink;
        const py1 = player.y + hitShrink;
        const px2 = player.x + ps - hitShrink;
        const py2 = player.y + ps - hitShrink;

        for (const ob of obstacles) {
            if (ob.type === "gap") continue; // Gaps handled separately
            const ox = ob.x - scrollX;
            const oy = ob.y;

            let hit = false;
            if (ob.type === "spike") {
                // Triangle hitbox approximation — shrink more
                const cx = ox + ob.w / 2;
                const cy = oy;
                const bx1 = ox + 4, bx2 = ox + ob.w - 4, by = oy + ob.h;
                // Simple AABB with extra shrink
                hit = px2 > ox + 8 && px1 < ox + ob.w - 8 && py2 > oy + 8 && py1 < oy + ob.h;
            } else if (ob.type === "saw") {
                // Circle hitbox
                const cx = ox + ob.w / 2, cy = oy + ob.h / 2;
                const r = ob.w / 2 - 4;
                const pcx = (px1 + px2) / 2, pcy = (py1 + py2) / 2;
                const dx = pcx - cx, dy = pcy - cy;
                hit = Math.sqrt(dx * dx + dy * dy) < r + ps / 2 - hitShrink;
            } else {
                // AABB (pillar etc)
                hit = px2 > ox && px1 < ox + ob.w && py2 > oy && py1 < oy + ob.h;
            }

            if (hit) {
                killPlayer();
                return;
            }
        }
    }

    function killPlayer() {
        if (!player || !player.alive) return;
        player.alive = false;
        SFX.death();
        triggerShake(8, 300);
        spawnDeathExplosion(player.x + CFG.PLAYER_SIZE / 2, player.y + CFG.PLAYER_SIZE / 2);

        // Stop ghost recording
        if (ghostRecording) {
            ghostRecording.completed = false;
            ghostRecording.totalTime = gameTime;
        }

        if (ws && mpState) {
            ws.send(JSON.stringify({ type: "player_died", progress: getProgress() }));
        }

        setTimeout(() => {
            if (gameState === "playing" && !mpState) {
                showScreen("screen-dead");
                document.getElementById("death-progress").textContent = `Progress: ${Math.floor(getProgress() * 100)}%`;
                document.getElementById("death-time").textContent = `Time: ${gameTime.toFixed(2)}s`;
                gameState = "dead";
            } else if (mpState) {
                // In multiplayer, just show death and wait for results
            }
        }, 800);
    }

    function getProgress() {
        return Math.min(scrollX / CFG.LEVEL_LENGTH, 1);
    }

    // ============================================
    // SCREEN SHAKE
    // ============================================
    function triggerShake(amount, duration) {
        shakeAmount = amount;
        shakeDuration = duration;
    }

    function updateShake(dt) {
        if (shakeDuration > 0) {
            shakeDuration -= dt;
            if (shakeDuration <= 0) shakeAmount = 0;
        }
    }

    function applyShake() {
        if (shakeAmount > 0) {
            const sx = (Math.random() * 2 - 1) * shakeAmount;
            const sy = (Math.random() * 2 - 1) * shakeAmount;
            ctx.translate(sx, sy);
        }
    }

    // ============================================
    // NOTIFICATIONS
    // ============================================
    function notify(text, type) {
        const el = document.createElement("div");
        el.className = `notification notif-${type || "info"}`;
        el.textContent = text;
        document.getElementById("notifications").appendChild(el);
        setTimeout(() => el.remove(), type === "finish" ? 3000 : 1500);
    }

    // ============================================
    // GHOST SYSTEM
    // ============================================
    let ghostSampleTimer = 0;
    const GHOST_INTERVAL = 1000 / CFG.GHOST_SAMPLE_HZ;

    function startGhostRecording() {
        ghostRecording = {
            seed: seed,
            character: selectedChar,
            totalTime: 0,
            completed: false,
            frames: [],
        };
        ghostSampleTimer = 0;
    }

    function recordGhostFrame(dt) {
        if (!ghostRecording || !player || !player.alive) return;
        ghostSampleTimer += dt;
        if (ghostSampleTimer >= GHOST_INTERVAL) {
            ghostSampleTimer -= GHOST_INTERVAL;
            ghostRecording.frames.push({
                t: gameTime,
                y: player.y,
                jumping: !player.grounded,
            });
        }
    }

    function saveGhostLocal() {
        if (!ghostRecording) return;
        const key = `ghost_${seed}`;
        const existing = localStorage.getItem(key);
        if (existing) {
            try {
                const old = JSON.parse(existing);
                if (old.completed && old.totalTime <= ghostRecording.totalTime) return;
            } catch {}
        }
        localStorage.setItem(key, JSON.stringify(ghostRecording));
    }

    function loadGhostLocal() {
        const key = `ghost_${seed}`;
        try {
            const data = localStorage.getItem(key);
            if (data) return JSON.parse(data);
        } catch {}
        return null;
    }

    async function loadGlobalGhost() {
        try {
            const resp = await fetch(`/api/ghosts/${seed}`);
            if (resp.ok) {
                globalGhost = await resp.json();
            } else {
                globalGhost = null;
            }
        } catch { globalGhost = null; }
    }

    async function saveGhostServer() {
        if (!ghostRecording || !ghostRecording.completed) return;
        try {
            await fetch(`/api/ghosts/${seed}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(ghostRecording),
            });
        } catch {}
    }

    function getGhostY(ghost, time) {
        if (!ghost || !ghost.frames || ghost.frames.length === 0) return null;
        const frames = ghost.frames;
        if (time <= frames[0].t) return frames[0].y;
        if (time >= frames[frames.length - 1].t) return frames[frames.length - 1].y;
        // Binary search for frame
        let lo = 0, hi = frames.length - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >> 1;
            if (frames[mid].t <= time) lo = mid; else hi = mid;
        }
        const f0 = frames[lo], f1 = frames[hi];
        const t = (time - f0.t) / (f1.t - f0.t);
        return f0.y + (f1.y - f0.y) * t;
    }

    // ============================================
    // DRAWING
    // ============================================
    function drawBackground() {
        // Dark gradient background
        const grad = ctx.createLinearGradient(0, 0, 0, CFG.HEIGHT);
        grad.addColorStop(0, "#0a0a1a");
        grad.addColorStop(0.5, "#0d0d25");
        grad.addColorStop(1, "#1a0a2a");
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, CFG.WIDTH, CFG.HEIGHT);

        // Parallax stars / decorations
        const parallax = scrollX * 0.15;
        for (const d of decorations) {
            const dx = d.x - parallax;
            const wrapped = ((dx % CFG.WIDTH) + CFG.WIDTH) % CFG.WIDTH;
            ctx.globalAlpha = d.alpha;
            ctx.fillStyle = "#7b8fff";
            ctx.beginPath();
            ctx.arc(wrapped, d.y, d.size, 0, Math.PI * 2);
            ctx.fill();
        }

        // Background grid lines (parallax)
        ctx.globalAlpha = 0.06;
        ctx.strokeStyle = "#00d4ff";
        ctx.lineWidth = 1;
        const gridSpacing = 80;
        const gridOffset = -(parallax % gridSpacing);
        for (let x = gridOffset; x < CFG.WIDTH; x += gridSpacing) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, CFG.HEIGHT);
            ctx.stroke();
        }
        for (let y = 0; y < CFG.HEIGHT; y += gridSpacing) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(CFG.WIDTH, y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    function drawGround() {
        // Ground surface
        ctx.fillStyle = "#1a1a2e";
        ctx.fillRect(0, CFG.GROUND_Y, CFG.WIDTH, CFG.HEIGHT - CFG.GROUND_Y);

        // Ground line with glow
        ctx.strokeStyle = "#00d4ff";
        ctx.lineWidth = 2;
        ctx.shadowColor = "#00d4ff";
        ctx.shadowBlur = 8;

        // Draw ground, skipping gaps
        ctx.beginPath();
        let drawing = true;
        for (let x = 0; x < CFG.WIDTH; x++) {
            let inGap = false;
            for (const ob of obstacles) {
                if (ob.type === "gap") {
                    const gx = ob.x - scrollX;
                    if (x >= gx && x <= gx + ob.w) {
                        inGap = true;
                        break;
                    }
                }
            }
            if (inGap) {
                drawing = false;
            } else {
                if (!drawing) { ctx.moveTo(x, CFG.GROUND_Y); drawing = true; }
                else if (x === 0) ctx.moveTo(x, CFG.GROUND_Y);
                else ctx.lineTo(x, CFG.GROUND_Y);
            }
        }
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Ground grid
        ctx.strokeStyle = "rgba(0, 212, 255, 0.08)";
        ctx.lineWidth = 1;
        const gridS = 40;
        const gOff = -(scrollX % gridS);
        for (let x = gOff; x < CFG.WIDTH; x += gridS) {
            let inGap = false;
            for (const ob of obstacles) {
                if (ob.type === "gap") {
                    const gx = ob.x - scrollX;
                    if (x >= gx && x <= gx + ob.w) { inGap = true; break; }
                }
            }
            if (inGap) continue;
            ctx.beginPath();
            ctx.moveTo(x, CFG.GROUND_Y);
            ctx.lineTo(x, CFG.HEIGHT);
            ctx.stroke();
        }
    }

    function drawObstacles() {
        const sawRotation = Date.now() / 100;
        for (const ob of obstacles) {
            const ox = ob.x - scrollX;
            if (ox < -100 || ox > CFG.WIDTH + 100) continue;

            if (ob.type === "spike") {
                ctx.fillStyle = "#ff3366";
                ctx.shadowColor = "#ff3366";
                ctx.shadowBlur = 6;
                ctx.beginPath();
                ctx.moveTo(ox + ob.w / 2, ob.y);
                ctx.lineTo(ox + ob.w, ob.y + ob.h);
                ctx.lineTo(ox, ob.y + ob.h);
                ctx.closePath();
                ctx.fill();
                ctx.shadowBlur = 0;
            } else if (ob.type === "pillar") {
                ctx.fillStyle = "#2a1a4a";
                ctx.fillRect(ox, ob.y, ob.w, ob.h);
                ctx.strokeStyle = "#7b2fff";
                ctx.lineWidth = 2;
                ctx.shadowColor = "#7b2fff";
                ctx.shadowBlur = 6;
                ctx.strokeRect(ox, ob.y, ob.w, ob.h);
                ctx.shadowBlur = 0;
            } else if (ob.type === "saw") {
                ctx.save();
                ctx.translate(ox + ob.w / 2, ob.y + ob.h / 2);
                ctx.rotate(sawRotation);
                ctx.fillStyle = "#ff6622";
                ctx.shadowColor = "#ff6622";
                ctx.shadowBlur = 8;
                // Draw saw teeth
                const r = ob.w / 2;
                const teeth = 8;
                ctx.beginPath();
                for (let i = 0; i < teeth; i++) {
                    const a1 = (i / teeth) * Math.PI * 2;
                    const a2 = ((i + 0.5) / teeth) * Math.PI * 2;
                    ctx.lineTo(Math.cos(a1) * r, Math.sin(a1) * r);
                    ctx.lineTo(Math.cos(a2) * (r * 0.7), Math.sin(a2) * (r * 0.7));
                }
                ctx.closePath();
                ctx.fill();
                ctx.shadowBlur = 0;
                // Inner circle
                ctx.fillStyle = "#cc4400";
                ctx.beginPath();
                ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            } else if (ob.type === "gap") {
                // Draw gap darkness
                ctx.fillStyle = "#050510";
                ctx.fillRect(ox, ob.y, ob.w, ob.h);
                // Edge glow
                ctx.strokeStyle = "#ff336666";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(ox, ob.y);
                ctx.lineTo(ox, ob.y + ob.h);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(ox + ob.w, ob.y);
                ctx.lineTo(ox + ob.w, ob.y + ob.h);
                ctx.stroke();
            }
        }

        // Platforms
        for (const plat of platforms) {
            const px = plat.x - scrollX;
            if (px < -200 || px > CFG.WIDTH + 200) continue;
            ctx.fillStyle = "#1a2a3a";
            ctx.fillRect(px, plat.y, plat.w, plat.h);
            ctx.strokeStyle = "#00d4ff";
            ctx.lineWidth = 2;
            ctx.shadowColor = "#00d4ff";
            ctx.shadowBlur = 4;
            ctx.strokeRect(px, plat.y, plat.w, plat.h);
            ctx.shadowBlur = 0;
        }
    }

    function drawPlayer(p, charName, alpha) {
        if (!p) return;
        ctx.save();
        ctx.globalAlpha = alpha || 1;
        const cx = p.x + CFG.PLAYER_SIZE / 2;
        const cy = p.y + CFG.PLAYER_SIZE / 2;
        ctx.translate(cx, cy);
        ctx.rotate((p.rotation || 0) * Math.PI / 180);

        const spriteName = charName + "-right";
        const sprite = sprites[spriteName];
        if (sprite && sprite.complete && sprite.naturalWidth > 0) {
            ctx.drawImage(sprite, -CFG.PLAYER_SIZE / 2, -CFG.PLAYER_SIZE / 2, CFG.PLAYER_SIZE, CFG.PLAYER_SIZE);
        } else {
            // Fallback colored square
            ctx.fillStyle = charName === "k1" ? "#00d4ff" : "#ff44aa";
            ctx.shadowColor = ctx.fillStyle;
            ctx.shadowBlur = 10;
            ctx.fillRect(-CFG.PLAYER_SIZE / 2, -CFG.PLAYER_SIZE / 2, CFG.PLAYER_SIZE, CFG.PLAYER_SIZE);
            ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    function drawGhost(ghost, charName, alpha) {
        if (!ghost) return;
        const gy = getGhostY(ghost, gameTime);
        if (gy === null) return;
        drawPlayer({ x: CFG.PLAYER_X, y: gy, rotation: 0 }, charName, alpha);
    }

    function drawHUD() {
        const progress = getProgress();
        const bar = document.getElementById("hud-progress-bar");
        const icon = document.getElementById("hud-progress-icon");
        bar.style.width = (progress * 100) + "%";
        icon.style.left = (progress * 100) + "%";
        document.getElementById("hud-timer").textContent = gameTime.toFixed(2) + "s";
        document.getElementById("hud-attempt").textContent = `Attempt #${attempt}`;
    }

    function drawMultiplayerPlayers() {
        if (!mpState || !mpState.remotePlayers) return;
        for (const rp of mpState.remotePlayers) {
            if (!rp || !rp.active) continue;
            // Interpolate
            rp.displayY = lerp(rp.displayY, rp.targetY, 0.2);
            rp.displayProgress = lerp(rp.displayProgress, rp.targetProgress, 0.15);
            // Draw at their progress position relative to ours
            const theirScrollX = rp.displayProgress * CFG.LEVEL_LENGTH;
            const relX = CFG.PLAYER_X + (theirScrollX - scrollX);
            if (relX < -100 || relX > CFG.WIDTH + 100) continue;
            drawPlayer({ x: relX, y: rp.displayY, rotation: rp.jumping ? Date.now() * 0.3 : 0 }, rp.character || "k2", 0.5);
            // Name tag
            ctx.fillStyle = "rgba(255,255,255,0.6)";
            ctx.font = "11px Orbitron, monospace";
            ctx.textAlign = "center";
            ctx.fillText(rp.name || "???", relX + CFG.PLAYER_SIZE / 2, rp.displayY - 8);
            ctx.textAlign = "left";
        }
    }

    function drawFinishLine() {
        const fx = CFG.LEVEL_LENGTH + 600 - scrollX; // +600 for initial offset
        if (fx < -50 || fx > CFG.WIDTH + 50) return;
        // Checkered flag pattern
        ctx.save();
        const flagW = 20, flagH = CFG.GROUND_Y;
        for (let row = 0; row < flagH / 20; row++) {
            for (let col = 0; col < 2; col++) {
                ctx.fillStyle = (row + col) % 2 === 0 ? "#fff" : "#222";
                ctx.globalAlpha = 0.8;
                ctx.fillRect(fx + col * 20, row * 20, 20, 20);
            }
        }
        ctx.globalAlpha = 1;
        // Glow line
        ctx.strokeStyle = "#ffd700";
        ctx.lineWidth = 3;
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.moveTo(fx, 0);
        ctx.lineTo(fx, CFG.GROUND_Y);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.restore();
    }

    // ============================================
    // GAME LOOP
    // ============================================
    let lastTime = 0;
    let trailTimer = 0;
    let mpUpdateTimer = 0;
    const MP_UPDATE_INTERVAL = 1000 / 10; // 10Hz

    function lerp(a, b, t) { return a + (b - a) * t; }

    function gameLoop(timestamp) {
        const dt = lastTime ? Math.min(timestamp - lastTime, 33.33) : 16.67;
        lastTime = timestamp;

        if (gameState === "playing") {
            gameTime += dt / 1000;
            speed = Math.min(CFG.BASE_SPEED + scrollX * CFG.SPEED_RAMP, CFG.MAX_SPEED);
            scrollX += speed;

            updatePlayer(dt);
            recordGhostFrame(dt);
            updateParticles();
            updateShake(dt);

            // Trail particles
            if (player && player.alive) {
                trailTimer += dt;
                if (trailTimer > 50) {
                    trailTimer = 0;
                    spawnTrailParticle(player.x, player.y);
                }
            }

            // Check win
            if (scrollX >= CFG.LEVEL_LENGTH && player && player.alive) {
                winLevel();
            }

            // Multiplayer updates
            if (ws && mpState) {
                mpUpdateTimer += dt;
                if (mpUpdateTimer >= MP_UPDATE_INTERVAL) {
                    mpUpdateTimer = 0;
                    ws.send(JSON.stringify({
                        type: "player_update",
                        progress: getProgress(),
                        y: player ? player.y : CFG.GROUND_Y - CFG.PLAYER_SIZE,
                        jumping: player ? !player.grounded : false,
                    }));
                }
            }
        } else {
            updateParticles();
            updateShake(dt);
        }

        // ── DRAW ──
        ctx.save();
        ctx.translate(offsetX, offsetY);
        ctx.scale(scale, scale);
        applyShake();

        drawBackground();
        drawGround();
        drawObstacles();
        drawFinishLine();

        // Draw ghosts
        if (gameState === "playing" || gameState === "dead") {
            if (localGhostCache && localGhostCache.frames && localGhostCache.frames.length > 0) {
                drawGhost(localGhostCache, localGhostCache.character || selectedChar, 0.25);
            }
            if (globalGhost && globalGhost.frames && globalGhost.frames.length > 0) {
                drawGhost(globalGhost, globalGhost.character || "k2", 0.2);
            }
        }

        // Draw multiplayer players
        drawMultiplayerPlayers();

        // Draw local player
        if (player && player.alive) {
            drawPlayer(player, selectedChar, 1);
        }

        drawParticles();

        ctx.restore();

        // HUD
        if (gameState === "playing") drawHUD();

        requestAnimationFrame(gameLoop);
    }

    function winLevel() {
        gameState = "win";
        SFX.win();
        notify("LEVEL COMPLETE!", "finish");

        if (ghostRecording) {
            ghostRecording.completed = true;
            ghostRecording.totalTime = gameTime;
            saveGhostLocal();
            saveGhostServer();
        }

        // Update best time
        const prevBest = bestTime;
        if (!bestTime || gameTime < bestTime) bestTime = gameTime;

        if (mpState && ws) {
            ws.send(JSON.stringify({ type: "player_finished", time: gameTime }));
            // Wait for results from server
        } else {
            showScreen("screen-win");
            document.getElementById("win-time").textContent = `Time: ${gameTime.toFixed(2)}s`;
            document.getElementById("win-best").textContent = bestTime ? `Best: ${bestTime.toFixed(2)}s` : "Best: --";
        }
    }

    // ============================================
    // GAME STATE MANAGEMENT
    // ============================================
    function startGame(levelSeed) {
        seed = levelSeed || Math.floor(Math.random() * 2147483647);
        generateLevel(seed);
        player = createPlayer();
        scrollX = 0;
        speed = CFG.BASE_SPEED;
        gameTime = 0;
        shakeAmount = 0;
        shakeDuration = 0;
        particles.releaseAll();
        trailTimer = 0;
        mpUpdateTimer = 0;

        startGhostRecording();
        localGhostCache = loadGhostLocal();
        loadGlobalGhost();

        gameState = "playing";
        hideAllScreens();
        document.getElementById("hud").classList.remove("hidden");
    }

    function restartGame() {
        attempt++;
        startGame(seed); // Same seed
    }

    function backToMenu() {
        gameState = "menu";
        hideAllScreens();
        showScreen("screen-start");
        document.getElementById("hud").classList.add("hidden");
        particles.releaseAll();
        if (ws) { ws.close(); ws = null; }
        mpState = null;
    }

    // ============================================
    // SCREENS
    // ============================================
    function hideAllScreens() {
        document.querySelectorAll(".overlay").forEach((el) => el.classList.add("hidden"));
    }

    function showScreen(id) {
        document.getElementById(id).classList.remove("hidden");
    }

    // ============================================
    // INPUT HANDLING
    // ============================================
    const keys = {};
    window.addEventListener("keydown", (e) => {
        if (e.code === "Space" || e.code === "ArrowUp" || e.key === "w" || e.key === "W") {
            e.preventDefault();
            if (gameState === "playing") playerJump();
            else if (gameState === "menu") {
                // Quick start
            }
        }
        keys[e.code] = true;
    });
    window.addEventListener("keyup", (e) => { keys[e.code] = false; });

    // Mouse / Touch
    canvas.addEventListener("mousedown", (e) => {
        e.preventDefault();
        if (gameState === "playing") playerJump();
    });
    canvas.addEventListener("touchstart", (e) => {
        e.preventDefault();
        if (gameState === "playing") playerJump();
    }, { passive: false });

    // Prevent zoom / scroll on mobile
    document.addEventListener("touchmove", (e) => { if (gameState === "playing") e.preventDefault(); }, { passive: false });

    // ============================================
    // MOBILE DETECTION
    // ============================================
    function detectMobile() {
        isMobile = ("ontouchstart" in window) || navigator.maxTouchPoints > 0 || window.innerWidth <= 768;
    }

    // ============================================
    // MULTIPLAYER
    // ============================================
    let wsPendingMessages = [];

    function wsSend(msg) {
        const data = JSON.stringify(msg);
        if (ws && ws.readyState === 1) {
            ws.send(data);
        } else {
            wsPendingMessages.push(data);
            connectWS();
        }
    }

    function connectWS() {
        if (ws && ws.readyState === 1) return;
        const proto = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${proto}//${location.host}`);

        ws.onopen = () => {
            console.log("WS connected");
            while (wsPendingMessages.length > 0) {
                ws.send(wsPendingMessages.shift());
            }
        };

        ws.onmessage = (e) => {
            let msg;
            try { msg = JSON.parse(e.data); } catch { return; }

            switch (msg.type) {
                case "room_created":
                    mpState = {
                        room: msg.room,
                        myIndex: msg.index,
                        code: msg.code,
                        seed: msg.seed,
                        isHost: true,
                        remotePlayers: [],
                    };
                    showLobby();
                    break;

                case "room_joined":
                    mpState = {
                        room: msg.room,
                        myIndex: msg.index,
                        code: msg.code,
                        seed: msg.seed,
                        isHost: msg.index === 0,
                        remotePlayers: [],
                    };
                    showLobby();
                    break;

                case "player_joined":
                    if (mpState) {
                        mpState.room = msg.room;
                        showLobby();
                    }
                    break;

                case "player_left":
                    if (mpState) {
                        mpState.room = msg.room || mpState.room;
                        notify(`${msg.name} left`, "info");
                        if (mpState.remotePlayers[msg.index]) {
                            mpState.remotePlayers[msg.index].active = false;
                        }
                    }
                    break;

                case "queue_waiting":
                    hideAllScreens();
                    showScreen("screen-queue");
                    break;

                case "race_countdown":
                    if (mpState) mpState.seed = msg.seed;
                    startCountdown(msg.seed);
                    break;

                case "race_go":
                    // Countdown handles this via setTimeout
                    break;

                case "remote_update":
                    if (mpState) {
                        if (!mpState.remotePlayers[msg.index]) {
                            mpState.remotePlayers[msg.index] = {
                                active: true,
                                targetY: CFG.GROUND_Y - CFG.PLAYER_SIZE,
                                displayY: CFG.GROUND_Y - CFG.PLAYER_SIZE,
                                targetProgress: 0,
                                displayProgress: 0,
                                jumping: false,
                                name: mpState.room.players[msg.index] ? mpState.room.players[msg.index].name : "???",
                                character: mpState.room.players[msg.index] ? mpState.room.players[msg.index].character : "k2",
                            };
                        }
                        const rp = mpState.remotePlayers[msg.index];
                        rp.targetY = msg.y;
                        rp.targetProgress = msg.progress;
                        rp.jumping = msg.jumping;
                        rp.active = true;
                    }
                    break;

                case "remote_jump":
                    // Visual feedback only
                    break;

                case "remote_died":
                    if (mpState && mpState.remotePlayers[msg.index]) {
                        mpState.remotePlayers[msg.index].active = false;
                        const name = mpState.remotePlayers[msg.index].name || "Player";
                        notify(`${name} crashed!`, "death");
                    }
                    break;

                case "remote_finished":
                    if (mpState) {
                        const name = mpState.remotePlayers[msg.index] ? mpState.remotePlayers[msg.index].name : "Player";
                        notify(`${name} finished #${msg.place}!`, "info");
                    }
                    break;

                case "your_place":
                    notify(`You finished #${msg.place}!`, "finish");
                    break;

                case "race_results":
                    showRaceResults(msg.results);
                    break;

                case "error":
                    notify(msg.message, "death");
                    break;

                case "opponent_disconnected":
                    notify("Opponent disconnected", "death");
                    break;
            }
        };

        ws.onclose = () => {
            console.log("WS closed");
            if (mpState && gameState === "playing") {
                notify("Disconnected from server", "death");
            }
        };
    }

    function showLobby() {
        hideAllScreens();
        showScreen("screen-lobby");
        document.getElementById("lobby-code").textContent = mpState.code;

        const container = document.getElementById("lobby-players");
        container.innerHTML = "";
        if (mpState.room && mpState.room.players) {
            mpState.room.players.forEach((p, i) => {
                if (!p) return;
                const div = document.createElement("div");
                div.className = "lobby-player" + (i === 0 ? " host" : "");
                div.innerHTML = `<img src="${p.character || "k1"}-right.png" alt="${p.character}"><span>${p.name || "Player"}</span>`;
                container.appendChild(div);
            });
        }

        const startBtn = document.getElementById("btn-start-race");
        if (mpState.isHost) {
            startBtn.classList.remove("hidden");
        } else {
            startBtn.classList.add("hidden");
        }

        const playerCount = mpState.room ? mpState.room.players.filter((p) => p).length : 0;
        document.getElementById("lobby-status").textContent =
            playerCount < 2 ? "Waiting for players..." : `${playerCount} players ready`;
    }

    function startCountdown(levelSeed) {
        hideAllScreens();
        showScreen("screen-countdown");
        document.getElementById("hud").classList.remove("hidden");

        // Generate level from seed
        seed = levelSeed;
        generateLevel(seed);
        player = createPlayer();
        scrollX = 0;
        speed = 0;
        gameTime = 0;
        particles.releaseAll();
        startGhostRecording();

        // Initialize remote players display
        if (mpState && mpState.room && mpState.room.players) {
            mpState.remotePlayers = [];
            mpState.room.players.forEach((p, i) => {
                if (i !== mpState.myIndex && p) {
                    mpState.remotePlayers[i] = {
                        active: true,
                        targetY: CFG.GROUND_Y - CFG.PLAYER_SIZE,
                        displayY: CFG.GROUND_Y - CFG.PLAYER_SIZE,
                        targetProgress: 0,
                        displayProgress: 0,
                        jumping: false,
                        name: p.name,
                        character: p.character,
                    };
                }
            });
        }

        gameState = "countdown";

        const numEl = document.getElementById("countdown-number");
        let count = 3;
        numEl.textContent = count;
        SFX.countdown();

        const interval = setInterval(() => {
            count--;
            if (count > 0) {
                numEl.textContent = count;
                numEl.style.animation = "none";
                void numEl.offsetWidth; // reflow
                numEl.style.animation = "countPulse 1s ease-out";
                SFX.countdown();
            } else if (count === 0) {
                numEl.textContent = "GO!";
                numEl.style.animation = "none";
                void numEl.offsetWidth;
                numEl.style.animation = "countPulse 1s ease-out";
                SFX.countdownGo();
            } else {
                clearInterval(interval);
                hideAllScreens();
                document.getElementById("hud").classList.remove("hidden");
                gameState = "playing";
                speed = CFG.BASE_SPEED;
            }
        }, 1000);
    }

    function showRaceResults(results) {
        gameState = "menu";
        hideAllScreens();
        showScreen("screen-results");
        document.getElementById("hud").classList.add("hidden");

        const container = document.getElementById("results-list");
        container.innerHTML = "";
        results.forEach((r, i) => {
            const div = document.createElement("div");
            div.className = "result-row" + (i === 0 ? " first" : "");
            const place = i + 1;
            const timeStr = r.finished ? r.time.toFixed(2) + "s" : `DNF (${Math.floor(r.progress * 100)}%)`;
            div.innerHTML = `<span class="result-place">#${place}</span><span class="result-name">${r.name}</span><span class="result-time">${timeStr}</span>`;
            container.appendChild(div);
        });
    }

    // ============================================
    // LEADERBOARD
    // ============================================
    async function loadLeaderboard() {
        try {
            const resp = await fetch("/api/leaderboard");
            if (resp.ok) {
                const data = await resp.json();
                const container = document.getElementById("leaderboard-list");
                container.innerHTML = "";
                if (data.length === 0) {
                    container.innerHTML = '<p style="text-align:center;color:rgba(255,255,255,0.4)">No scores yet</p>';
                    return;
                }
                data.forEach((entry, i) => {
                    const div = document.createElement("div");
                    div.className = "lb-row";
                    div.innerHTML = `<span class="lb-rank">#${i + 1}</span><span class="lb-name">${entry.name}</span><span class="lb-time">${entry.time.toFixed(2)}s</span>`;
                    container.appendChild(div);
                });
            }
        } catch {}
    }

    async function submitScore(name, time) {
        try {
            await fetch("/api/leaderboard", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name, time, seed }),
            });
        } catch {}
    }

    // ============================================
    // UI EVENT LISTENERS
    // ============================================
    function initUI() {
        // Start screen
        document.getElementById("btn-play").addEventListener("click", () => {
            SFX.click();
            attempt = 1;
            bestTime = null;
            startGame();
        });

        document.getElementById("btn-multiplayer").addEventListener("click", () => {
            SFX.click();
            hideAllScreens();
            showScreen("screen-mp");
        });

        document.getElementById("btn-leaderboard").addEventListener("click", () => {
            SFX.click();
            hideAllScreens();
            showScreen("screen-leaderboard");
            loadLeaderboard();
        });

        document.getElementById("btn-character").addEventListener("click", () => {
            SFX.click();
            hideAllScreens();
            showScreen("screen-character");
        });

        // Character select
        document.querySelectorAll(".char-option").forEach((el) => {
            el.addEventListener("click", () => {
                SFX.click();
                document.querySelectorAll(".char-option").forEach((o) => o.classList.remove("selected"));
                el.classList.add("selected");
                selectedChar = el.dataset.char;
            });
        });

        document.getElementById("btn-char-back").addEventListener("click", () => {
            SFX.click();
            hideAllScreens();
            showScreen("screen-start");
        });

        // Leaderboard
        document.getElementById("btn-lb-back").addEventListener("click", () => {
            SFX.click();
            hideAllScreens();
            showScreen("screen-start");
        });

        // Death screen
        document.getElementById("btn-retry").addEventListener("click", () => {
            SFX.click();
            restartGame();
        });
        document.getElementById("btn-back-menu").addEventListener("click", () => {
            SFX.click();
            backToMenu();
        });

        // Win screen
        document.getElementById("btn-replay").addEventListener("click", () => {
            SFX.click();
            attempt++;
            startGame(seed);
        });
        document.getElementById("btn-win-menu").addEventListener("click", () => {
            SFX.click();
            backToMenu();
        });
        document.getElementById("btn-submit-score").addEventListener("click", () => {
            const name = document.getElementById("win-name").value.trim();
            if (name) {
                submitScore(name, gameTime);
                document.getElementById("btn-submit-score").textContent = "SUBMITTED!";
                document.getElementById("btn-submit-score").disabled = true;
            }
        });

        // Multiplayer
        document.getElementById("btn-create-room").addEventListener("click", () => {
            SFX.click();
            wsSend({ type: "create_room", name: getPlayerName(), character: selectedChar });
        });

        document.getElementById("btn-join-room").addEventListener("click", () => {
            SFX.click();
            const code = document.getElementById("input-room-code").value.trim().toUpperCase();
            if (!code) return;
            wsSend({ type: "join_room", code, name: getPlayerName(), character: selectedChar });
        });

        document.getElementById("btn-quick-match").addEventListener("click", () => {
            SFX.click();
            wsSend({ type: "quick_match", name: getPlayerName(), character: selectedChar });
        });

        document.getElementById("btn-mp-back").addEventListener("click", () => {
            SFX.click();
            hideAllScreens();
            showScreen("screen-start");
        });

        // Lobby
        document.getElementById("btn-start-race").addEventListener("click", () => {
            SFX.click();
            if (ws && mpState) {
                ws.send(JSON.stringify({ type: "start_race" }));
            }
        });

        document.getElementById("btn-leave-room").addEventListener("click", () => {
            SFX.click();
            if (ws) ws.send(JSON.stringify({ type: "leave_room" }));
            mpState = null;
            hideAllScreens();
            showScreen("screen-mp");
        });

        // Queue
        document.getElementById("btn-cancel-queue").addEventListener("click", () => {
            SFX.click();
            if (ws) ws.close();
            ws = null;
            mpState = null;
            hideAllScreens();
            showScreen("screen-mp");
        });

        // Results
        document.getElementById("btn-results-menu").addEventListener("click", () => {
            SFX.click();
            backToMenu();
        });

        // Mute
        document.getElementById("btn-mute").addEventListener("click", () => SFX.toggleMute());
    }

    function getPlayerName() {
        return localStorage.getItem("dash_player_name") || "Player" + Math.floor(Math.random() * 999);
    }

    // ============================================
    // INIT
    // ============================================
    function init() {
        detectMobile();
        resize();
        initUI();
        showScreen("screen-start");
        requestAnimationFrame(gameLoop);
    }

    init();
})();
