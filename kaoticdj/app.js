/**
 * KaoticDJ - Dual Deck WebMIDI Controller
 * Loads MIDI controller profiles from configs/*.json
 * Supports Korg KaossDJ and other dual-deck controllers
 */

// ============================================================
// STATE
// ============================================================
const state = {
    decks: [
        { id: 0, playing: false, cueing: false, looping: false, synced: false,
          volume: 100, filter: 64, eq: { hi: 64, mid: 64, low: 64 },
          bpm: null, track: null, source: null, gainNode: null,
          eqNodes: { hi: null, mid: null, low: null }, filterNode: null,
          analyserNode: null, currentTime: 0, duration: 0,
          startOffset: 0, startTime: 0, pausedAt: 0, isPaused: false,
          waveformData: null, jogAngle: 0, wasPlayingBeforeCue: false,
          deckType: 'audio', // 'audio' | 'tracker'
          statusMsg: '',
          modPlayer: null, modModule: null, modScriptNode: null, modBufferPtr: null, trackerRAF: null,
          workletNode: null, useWasm: false, loopStart: -1, loopEnd: -1 },
        { id: 1, playing: false, cueing: false, looping: false, synced: false,
          volume: 100, filter: 64, eq: { hi: 64, mid: 64, low: 64 },
          bpm: null, track: null, source: null, gainNode: null,
          eqNodes: { hi: null, mid: null, low: null }, filterNode: null,
          analyserNode: null, currentTime: 0, duration: 0,
          startOffset: 0, startTime: 0, pausedAt: 0, isPaused: false,
          waveformData: null, jogAngle: 0, wasPlayingBeforeCue: false,
          deckType: 'audio',
          statusMsg: '',
          modPlayer: null, modModule: null, modScriptNode: null, modBufferPtr: null, trackerRAF: null,
          loopStart: -1, loopEnd: -1 }
    ],
    crossfader: 64,
    audioContext: null,
    masterGain: null,
    crossfaderGain: { a: null, b: null },
    midiAccess: null,
    midiOutput: null,
    midiInput: null,
    midiLearnTarget: null,
    isLearning: false,
    animationId: null,
    waveformAnimIds: [null, null],
    jogAnimIds: [null, null],

    // WASM worklet nodes (separate from state.decks to avoid property issues)
    workletNodes: [null, null],

    // Controller profile system
    profiles: [],               // All available profiles [{meta, decks, ...}]
    activeProfile: null,        // Currently selected profile object
    profileOverrides: {},       // User overrides from MIDI learn: { profileName: { controlKey: {...} } }
    midiLookup: null,           // Built lookup table: { "ch0_cc71": {control, deck} }
    activeProfileName: null     // Persisted name
};

// ============================================================
// BPM WORKER
// ============================================================
let bpmWorker = null;

function initBPMWorker() {
    try {
        bpmWorker = new Worker('bpm-worker.js');
        bpmWorker.onmessage = (e) => {
            const { deckIndex, bpm } = e.data;
            if (bpm) {
                state.decks[deckIndex].bpm = bpm;
                document.getElementById(`bpm-${deckIndex}`).textContent = `${bpm} BPM`;
                setTrackStatus(deckIndex, `${bpm} BPM`, 'ready');
            } else {
                setTrackStatus(deckIndex, 'BPM: unknown', 'ready');
            }
        };
        bpmWorker.onerror = (err) => {
            console.warn('[BPM] Worker error:', err);
            bpmWorker = null;
        };
    } catch (e) {
        console.warn('[BPM] Workers not supported:', e);
    }
}

function setTrackStatus(deckIndex, msg, cls = '') {
    const el = document.getElementById(`trackStatus-${deckIndex}`);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'track-status' + (cls ? ' ' + cls : '');
}

const TRACKER_EXTS = ['.mod', '.med', '.ahx', '.sid', '.xm', '.s3m', '.it'];

function isTrackerFile(file) {
    const name = file.name.toLowerCase();
    return TRACKER_EXTS.some(ext => name.endsWith(ext));
}

// ============================================================
// CONTROLLER PROFILE SYSTEM
// ============================================================

/**
 * Load all available controller profiles from configs/devices.json index
 */
async function loadProfiles() {
    try {
        // Load the device index
        const indexResp = await fetch('configs/devices.json');
        const index = indexResp.ok ? await indexResp.json() : null;

        let deviceFiles = [];
        if (index && index.devices && index.devices.length > 0) {
            deviceFiles = index.devices.map(d => d.file);
        } else {
            // Fallback: try known filenames
            deviceFiles = ['kaossdj.json', 'template.json'];
        }

        const profiles = [];
        for (const file of deviceFiles) {
            try {
                const resp = await fetch(`configs/${file}`);
                if (resp.ok) {
                    const profile = await resp.json();
                    profiles.push(profile);
                    console.log(`[Config] Loaded: ${profile.name || file}`);
                }
            } catch (e) {
                console.warn(`[Config] Could not load ${file}:`, e);
            }
        }

        if (profiles.length === 0) {
            profiles.push(createFallbackProfile());
            console.warn('[Config] No profiles loaded, using fallback');
        }

        state.profiles = profiles;

        // Load saved profile preference
        const savedName = localStorage.getItem('kaoticdj_active_profile');
        const saved = savedName && profiles.find(p => p.name === savedName);
        const profile = saved || profiles[0];
        await activateProfile(profile);

        populateProfileSelector();
        return profiles;

    } catch (err) {
        console.error('[Config] Profile system error:', err);
        const fallback = createFallbackProfile();
        state.profiles = [fallback];
        await activateProfile(fallback);
        return [fallback];
    }
}

/**
 * Create a minimal fallback profile using the sections-based format
 */
function createFallbackProfile() {
    return {
        id: "fallback",
        name: "Built-in Fallback",
        manufacturer: "System",
        description: "Fallback profile when config files cannot be loaded",
        deckConfig: { count: 2, type: "audio", midiBaseChannel: 0 },
        sections: [
            {
                title: "Deck A", deck: 0, midiChannel: 0, color: "#ff4444",
                controls: [
                    { id: "eqHi",   type: "knob", label: "EQ Hi",   cc: 71, min: 0, max: 127, "default": 64 },
                    { id: "eqMid",  type: "knob", label: "EQ Mid",  cc: 72, min: 0, max: 127, "default": 64 },
                    { id: "eqLow",  type: "knob", label: "EQ Low",  cc: 73, min: 0, max: 127, "default": 64 },
                    { id: "filter", type: "knob", label: "Filter",  cc: 74, min: 0, max: 127, "default": 64 },
                    { id: "fader",  type: "knob", label: "Volume",  cc: 7,  min: 0, max: 127, "default": 100 },
                    { id: "play",   type: "pad",  label: "Play",    note: 37 },
                    { id: "cue",    type: "pad",  label: "Cue",     note: 39 }
                ]
            },
            {
                title: "Deck B", deck: 1, midiChannel: 1, color: "#4488ff",
                controls: [
                    { id: "eqHi",   type: "knob", label: "EQ Hi",   cc: 75, min: 0, max: 127, "default": 64 },
                    { id: "eqMid",  type: "knob", label: "EQ Mid",  cc: 76, min: 0, max: 127, "default": 64 },
                    { id: "eqLow",  type: "knob", label: "EQ Low",  cc: 77, min: 0, max: 127, "default": 64 },
                    { id: "filter", type: "knob", label: "Filter",  cc: 78, min: 0, max: 127, "default": 64 },
                    { id: "fader",  type: "knob", label: "Volume",  cc: 7,  min: 0, max: 127, "default": 100 },
                    { id: "play",   type: "pad",  label: "Play",    note: 37 },
                    { id: "cue",    type: "pad",  label: "Cue",     note: 39 }
                ]
            },
            {
                title: "Master",
                controls: [
                    { id: "crossfader", type: "knob", label: "Crossfader", cc: 8, channel: 0, min: 0, max: 127, "default": 64 }
                ]
            }
        ]
    };
}

/**
 * Activate a controller profile: build lookups and apply to UI
 */
async function activateProfile(profile) {
    if (!profile) return;

    state.activeProfile = profile;
    state.activeProfileName = profile.name;

    localStorage.setItem('kaoticdj_active_profile', profile.name);

    loadProfileOverrides(profile.name);

    // Build the MIDI lookup table from profile sections + overrides
    state.midiLookup = buildMidiLookup(profile);

    const deckCount = (profile.deckConfig && profile.deckConfig.count) || 2;

    updateProfileUI(profile);

    console.log(`[Config] Activated: ${profile.name} (${deckCount} decks)`);
    addMidiLog(`Controller: ${profile.name}`, 'info');
}

/**
 * Resolve the effective MIDI channel for a control within a section.
 * Priority: control.channel → section.midiChannel → deckConfig.midiBaseChannel + deck
 */
function resolveChannel(profile, section, ctrl) {
    if (ctrl.channel !== undefined) return ctrl.channel;
    if (section.midiChannel !== undefined) return section.midiChannel;
    const base = (profile.deckConfig && profile.deckConfig.midiBaseChannel) || 0;
    const deck = section.deck;
    return deck !== undefined ? base + deck : 0;
}

/**
 * Build a flat MIDI lookup table from a profile using sections-based format.
 * Maps "ch{channel}_cc{cc}" or "ch{channel}_note{note}" to {control, deckId}
 */
function buildMidiLookup(profile) {
    const lookup = {};
    const overrides = state.profileOverrides[profile.name] || {};

    function addEntry(channel, midiType, midiValue, control, deckId) {
        if (midiValue === undefined || midiValue === null) return;
        const key = `ch${channel}_${midiType}${midiValue}`;
        lookup[key] = { control, deckId, channel };
    }

    for (const section of profile.sections || []) {
        const deckId = section.deck !== undefined ? section.deck : -1;
        for (const ctrl of section.controls || []) {
            const overrideKey = `${ctrl.id}|d${deckId}`;
            const override = overrides[overrideKey];

            const channel = override && override.channel !== undefined
                ? override.channel
                : resolveChannel(profile, section, ctrl);

            const useType = override ? override.type : ctrl.type;
            const isKnob = (ctrl.type === 'knob' || ctrl.type === 'select' || useType === 'cc');
            const isPad = (ctrl.type === 'pad' || ctrl.type === 'toggle');

            if (override) {
                const val = override.type === 'cc' ? override.cc : override.note;
                addEntry(channel, override.type === 'cc' ? 'cc' : 'note', val, ctrl, deckId);
            } else if (isKnob || ctrl.cc !== undefined) {
                addEntry(channel, 'cc', ctrl.cc, ctrl, deckId);
            } else if (isPad || ctrl.note !== undefined) {
                addEntry(channel, 'note', ctrl.note, ctrl, deckId);
            }
        }
    }

    return lookup;
}

/**
 * Build the list of all known controls from the active profile's sections
 * (for mapping editor and MIDI learn)
 */
function getProfileControls(profile) {
    const all = [];
    if (!profile || !profile.sections) return all;

    for (const section of profile.sections) {
        const deckId = section.deck !== undefined ? section.deck : -1;
        const deckLabel = section.deck !== undefined
            ? (section.title || `Deck ${String.fromCharCode(65 + deckId)}`)
            : 'Global';

        for (const ctrl of section.controls || []) {
            all.push({
                ...ctrl,
                deckId: deckId,
                deckLabel: deckLabel,
                sectionTitle: section.title,
                controlKey: `${ctrl.id}|d${deckId}`,
                scope: section.deck !== undefined ? 'deck' : 'global'
            });
        }
    }

    return all;
}

/**
 * Get the binding string for a control from the active profile's sections
 */
function getControlBinding(profile, controlKey) {
    const overrides = state.profileOverrides[profile.name] || {};
    const override = overrides[controlKey];

    if (override) {
        const v = override.type === 'cc' ? override.cc : override.note;
        return `Ch ${override.channel + 1} ${override.type === 'cc' ? 'CC' : 'Note'} ${v}`;
    }

    // Find from profile sections
    for (const section of profile.sections || []) {
        const deckId = section.deck !== undefined ? section.deck : -1;
        for (const ctrl of section.controls || []) {
            if (`${ctrl.id}|d${deckId}` === controlKey) {
                const ch = resolveChannel(profile, section, ctrl);
                if (ctrl.cc !== undefined) {
                    return `Ch ${ch + 1} CC ${ctrl.cc}`;
                } else if (ctrl.note !== undefined) {
                    return `Ch ${ch + 1} Note ${ctrl.note}`;
                }
                return 'Not mapped';
            }
        }
    }

    return 'Not mapped';
}

// ============================================================
// PROFILE PERSISTENCE (MIDI Learn overrides)
// ============================================================

/**
 * Load user overrides for a specific profile
 */
function loadProfileOverrides(profileName) {
    try {
        const saved = localStorage.getItem(`kaoticdj_overrides_${profileName}`);
        if (saved) {
            state.profileOverrides[profileName] = JSON.parse(saved);
        } else {
            state.profileOverrides[profileName] = {};
        }
    } catch (e) {
        console.warn('[Config] Could not load overrides:', e);
        state.profileOverrides[profileName] = {};
    }
}

/**
 * Save user overrides for the active profile
 */
function saveProfileOverrides() {
    if (!state.activeProfile) return;
    try {
        const name = state.activeProfile.name;
        localStorage.setItem(`kaoticdj_overrides_${name}`,
            JSON.stringify(state.profileOverrides[name] || {}));
    } catch (e) {
        console.warn('[Config] Could not save overrides:', e);
    }
}

/**
 * Set a MIDI learn override for a control
 */
function setControlOverride(controlKey, messageType, channel, data1) {
    if (!state.activeProfile) return;
    const name = state.activeProfile.name;
    if (!state.profileOverrides[name]) {
        state.profileOverrides[name] = {};
    }

    const isCC = messageType === 0xB0;
    state.profileOverrides[name][controlKey] = {
        type: isCC ? 'cc' : 'note',
        channel: channel,
        [isCC ? 'cc' : 'note']: data1
    };

    saveProfileOverrides();

    // Rebuild lookup
    state.midiLookup = buildMidiLookup(state.activeProfile);
}

/**
 * Clear override for a control
 */
function clearControlOverride(controlKey) {
    if (!state.activeProfile) return;
    const name = state.activeProfile.name;
    if (state.profileOverrides[name]) {
        delete state.profileOverrides[name][controlKey];
        saveProfileOverrides();
        state.midiLookup = buildMidiLookup(state.activeProfile);
    }
}

/**
 * Reset all overrides for active profile to defaults
 */
function resetProfileOverrides() {
    if (!state.activeProfile) return;
    const name = state.activeProfile.name;
    state.profileOverrides[name] = {};
    saveProfileOverrides();
    state.midiLookup = buildMidiLookup(state.activeProfile);
    console.log('[Config] Overrides reset to defaults');
}

// ============================================================
// PROFILE UI
// ============================================================

function populateProfileSelector() {
    const select = document.getElementById('controllerProfileSelect');
    if (!select) return;

    select.innerHTML = '';
    for (const profile of state.profiles) {
        const opt = document.createElement('option');
        opt.value = profile.name;
        opt.textContent = profile.name;
        if (state.activeProfileName === profile.name) {
            opt.selected = true;
        }
        select.appendChild(opt);
    }
}

function updateProfileUI(profile) {
    if (!profile) return;

    // Update deck colors from sections with deck assignments
    for (const section of profile.sections || []) {
        if (section.deck !== undefined && section.color) {
            const deckEl = document.querySelector(`#deck-${section.deck} .deck-label`);
            if (deckEl) {
                deckEl.style.color = section.color;
            }
        }
    }
}

// ============================================================
// AUDIO ENGINE
// ============================================================
async function initAudio() {
    if (state.audioContext) return;

    state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    state.masterGain = state.audioContext.createGain();
    state.masterGain.gain.value = 1.0;
    state.masterGain.connect(state.audioContext.destination);

    state.crossfaderGain.a = state.audioContext.createGain();
    state.crossfaderGain.a.gain.value = 1.0;
    state.crossfaderGain.a.connect(state.masterGain);

    state.crossfaderGain.b = state.audioContext.createGain();
    state.crossfaderGain.b.gain.value = 0.0;
    state.crossfaderGain.b.connect(state.masterGain);

    for (let d = 0; d < 2; d++) {
        setupDeckAudio(d);
    }

    updateCrossfader(state.crossfader);
    console.log('[Audio] Initialized');

    // Load WASM effects (required for playback)
    try {
        await loadWasmEffects();
        console.log('[WASM] Ready for both decks');
    } catch (e) {
        console.error('[WASM] FAILED:', e.message);
        console.error('[WASM] Check that regroove-effects.js/.wasm and audio-worklet-processor.js exist');
        console.error('[WASM] Serve via HTTP (not file://) for AudioWorklet to work');
    }

    populateAudioOutputs();
}

function setupDeckAudio(deckIndex) {
    const deck = state.decks[deckIndex];
    const ctx = state.audioContext;

    // Master gain for this deck
    deck.gainNode = ctx.createGain();
    deck.gainNode.gain.value = deck.volume / 127;

    // --- Crossover DJ Kill EQ ---
    // Split the spectrum into 3 bands with separate gain stages
    // Low: lowpass at 300Hz, Mid: 300-3000Hz, High: highpass at 3000Hz

    // Low band: lowpass filter + gain
    deck.eqNodes.lowFilter = ctx.createBiquadFilter();
    deck.eqNodes.lowFilter.type = 'lowpass';
    deck.eqNodes.lowFilter.frequency.value = 300;
    deck.eqNodes.lowFilter.Q.value = 0.7;
    deck.eqNodes.lowGain = ctx.createGain();
    deck.eqNodes.lowGain.gain.value = 1;

    // Mid band: bandpass filter + gain
    deck.eqNodes.midFilter = ctx.createBiquadFilter();
    deck.eqNodes.midFilter.type = 'bandpass';
    deck.eqNodes.midFilter.frequency.value = 1000;
    deck.eqNodes.midFilter.Q.value = 0.7;
    deck.eqNodes.midGain = ctx.createGain();
    deck.eqNodes.midGain.gain.value = 1;

    // High band: highpass filter + gain
    deck.eqNodes.highFilter = ctx.createBiquadFilter();
    deck.eqNodes.highFilter.type = 'highpass';
    deck.eqNodes.highFilter.frequency.value = 3000;
    deck.eqNodes.highFilter.Q.value = 0.7;
    deck.eqNodes.highGain = ctx.createGain();
    deck.eqNodes.highGain.gain.value = 1;

    // Low-pass filter
    deck.filterNode = ctx.createBiquadFilter();
    deck.filterNode.type = 'lowpass';
    deck.filterNode.frequency.value = 22000;
    deck.filterNode.Q.value = 0.5;

    // Summer: combine the three bands back together
    deck.eqSummer = ctx.createGain();
    deck.eqSummer.gain.value = 1;

    // Analyser for waveform
    deck.analyserNode = ctx.createAnalyser();
    deck.analyserNode.fftSize = 2048;

    // Connect chain: source -> eq bands (parallel) -> summer -> filter -> gain -> analyser -> crossfader
    // Each band: filter -> gain. The three gains connect to summer.
    // summer -> filter -> gainNode -> analyser -> crossfader
    deck.eqNodes.lowFilter.connect(deck.eqNodes.lowGain);
    deck.eqNodes.lowGain.connect(deck.eqSummer);

    deck.eqNodes.midFilter.connect(deck.eqNodes.midGain);
    deck.eqNodes.midGain.connect(deck.eqSummer);

    deck.eqNodes.highFilter.connect(deck.eqNodes.highGain);
    deck.eqNodes.highGain.connect(deck.eqSummer);

    deck.eqSummer.connect(deck.filterNode);
    deck.filterNode.connect(deck.gainNode);
    deck.gainNode.connect(deck.analyserNode);

    const xfadeTarget = deckIndex === 0 ? state.crossfaderGain.a : state.crossfaderGain.b;
    deck.analyserNode.connect(xfadeTarget);
}

// ============================================================
// WASM EFFECTS — ScriptProcessorNode (works on HTTP + file://)
// ============================================================

// ============================================================
// WASM EFFECTS — AudioWorklet (HTTPS) + ScriptProcessor (file:///HTTP)
// ============================================================

async function loadWasmEffects() {
    if (!state.audioContext) throw new Error('No AudioContext');
    const ctx = state.audioContext;

    const [jsResp, wasmResp] = await Promise.all([
        fetch('regroove-effects.js'),
        fetch('regroove-effects.wasm'),
    ]);
    if (!jsResp.ok || !wasmResp.ok) throw new Error('WASM files missing');

    const jsCode = await jsResp.text();
    const wasmBytes = await wasmResp.arrayBuffer();
    // Keep an independent copy for the ScriptProcessor fallback
    const wasmBytesFallback = wasmBytes.slice(0);

    // Try AudioWorklet first (HTTPS/localhost)
    if (ctx.audioWorklet) {
        try {
            await ctx.audioWorklet.addModule('audio-worklet-processor.js');
            for (let d = 0; d < 2; d++) await initWorkletDeck(d, jsCode, wasmBytes);
            console.log('[WASM] AudioWorklet mode');
            return;
        } catch (e) {
            console.warn('[WASM] AudioWorklet failed:', e.message);
        }
    }

    await initScriptProcessorMode(ctx, jsCode, wasmBytesFallback);
    console.log('[WASM] ScriptProcessorNode mode');
}

async function initWorkletDeck(deckIndex, jsCode, wasmBytes) {
    const deck = state.decks[deckIndex];
    const ctx = state.audioContext;
    const wn = new AudioWorkletNode(ctx, 'wasm-effects-processor');
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => { wn.port.onmessage = null; reject(new Error('Timeout')); }, 10000);
        wn.port.onmessage = (e) => {
            if (e.data.type === 'needWasm') {
                wn.port.postMessage({ type: 'wasmBytes', data: { jsCode, wasmBytes: wasmBytes.slice(0) } });
            } else if (e.data.type === 'ready') { clearTimeout(t); resolve(); }
            else if (e.data.type === 'error') { clearTimeout(t); reject(new Error(e.data.error)); }
        };
    });
    const s = (e, p, v) => wn.port.postMessage({ type: 'setParam', data: { effect: e, param: p, value: v } });
    s('model1_trim', 'drive', 0.7); s('model1_hpf', 'cutoff', 0); s('model1_lpf', 'cutoff', 1);
    s('model1_sculpt', 'frequency', 0.5); s('model1_sculpt', 'gain', 0.5);
    wn.port.postMessage({ type: 'toggle', data: { name: 'eq', enabled: true } });
    s('eq', 'low', 0.5); s('eq', 'mid', 0.5); s('eq', 'high', 0.5);
    wn.port.postMessage({ type: 'toggle', data: { name: 'filter', enabled: true } });
    s('filter', 'cutoff', 1); s('filter', 'resonance', 0);
    wn.connect(deck.gainNode);
    deck.workletNode = wn;
    deck.audioMode = 'worklet';
    console.log(`[WASM] Deck ${deckIndex} via AudioWorklet`);
}

async function initScriptProcessorMode(ctx, jsCode, wasmBytes) {
    const mc = jsCode.replace(';return moduleRtn', ';globalThis.__wasmMemory=wasmMemory;return moduleRtn');
    eval(mc + '\nglobalThis.RegrooveEffectsModule = RegrooveEffectsModule;');
    const wm = await globalThis.RegrooveEffectsModule({ wasmBinary: wasmBytes });
    const mem = globalThis.__wasmMemory;
    delete globalThis.RegrooveEffectsModule; delete globalThis.__wasmMemory;

    for (let d = 0; d < 2; d++) {
        const deck = state.decks[d];

        function fx(n, p) {
            const ptr = wm[p + '_create']();
            const se = wm[p + '_set_enabled'];
            if (se) se(ptr, 0);
            return { ptr, name: n, prefix: p };
        }
        const ef = {
            trim: fx('t', '_fx_model1_trim'), sculpt: fx('s', '_fx_model1_sculpt'),
            lpf: fx('l', '_fx_model1_lpf'), hpf: fx('h', '_fx_model1_hpf'),
            eq: fx('eq', '_fx_eq'), filter: fx('f', '_fx_filter')
        };
        for (const k of Object.keys(ef)) wm[ef[k].prefix + '_set_enabled'](ef[k].ptr, 1);
        const sp = (e, p, v) => wm[e.prefix + '_set_' + p](e.ptr, v);
        sp(ef.trim, 'drive', 0.7); sp(ef.hpf, 'cutoff', 0); sp(ef.lpf, 'cutoff', 1);
        sp(ef.sculpt, 'frequency', 0.5); sp(ef.sculpt, 'gain', 0.5);
        sp(ef.eq, 'low', 0.5); sp(ef.eq, 'mid', 0.5); sp(ef.eq, 'high', 0.5);
        sp(ef.filter, 'cutoff', 1); sp(ef.filter, 'resonance', 0);
        deck.wasmEffects = ef; deck.wasmModule = wm;

        const bp = wm._malloc(2048 * 2 * 4);
        deck.wasmBufPtr = bp;
        new Float32Array(mem.buffer, bp, 2048 * 2).fill(0);
        const sn = ctx.createScriptProcessor(2048, 2, 2);
        const order = [ef.trim, ef.sculpt, ef.lpf, ef.hpf, ef.eq, ef.filter];
        sn.onaudioprocess = (e) => {
            const iL = e.inputBuffer.getChannelData(0), iR = e.inputBuffer.getChannelData(1);
            const oL = e.outputBuffer.getChannelData(0), oR = e.outputBuffer.getChannelData(1);
            const fr = iL.length;
            if (!deck.playing) { oL.set(iL); oR.set(iR); return; }
            const h = new Float32Array(mem.buffer, bp, fr * 2);
            for (let i = 0; i < fr; i++) { h[i * 2] = iL[i]; h[i * 2 + 1] = iR[i]; }
            for (const f of order) { const fn = wm[f.prefix + '_process_f32']; if (fn) fn(f.ptr, bp, fr, ctx.sampleRate); }
            for (let i = 0; i < fr; i++) { oL[i] = h[i * 2]; oR[i] = h[i * 2 + 1]; }
        };
        sn.connect(deck.gainNode);
        deck.workletNode = sn;
        deck.audioMode = 'script';
        console.log(`[WASM] Deck ${d} via ScriptProcessor`);
    }
}

// ============================================================
// DECK PLAYBACK (Audio Engine)
// ============================================================
function loadTrackToDeck(deckIndex, file) {
    const deck = state.decks[deckIndex];
    const ctx = state.audioContext;

    if (!file) return;

    stopDeck(deckIndex);
    cleanupModPlayer(deckIndex);

    setTrackStatus(deckIndex, 'Loading...');
    document.querySelector(`#trackInfo-${deckIndex} .track-name`).textContent = file.name;
    document.querySelector(`#trackInfo-${deckIndex} .track-name`).title = file.name;

    if (isTrackerFile(file)) {
        loadTrackerFile(deckIndex, file);
    } else {
        loadAudioFile(deckIndex, file);
    }
}

async function loadAudioFile(deckIndex, file) {
    const deck = state.decks[deckIndex];
    const ctx = state.audioContext;

    deck.deckType = 'audio';

    try {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const arrayBuffer = e.target.result;
                setTrackStatus(deckIndex, 'Decoding...');
                await new Promise(r => setTimeout(r, 50)); // yield to UI
                const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

                deck.track = audioBuffer;
                deck.duration = audioBuffer.duration;
                deck.currentTime = 0;
                deck.startOffset = 0;

                updateTimeDisplay(deckIndex);
                generateWaveform(deckIndex, audioBuffer);

                // BPM detection via worker
                if (bpmWorker) {
                    setTrackStatus(deckIndex, 'Analyzing BPM...');
                    // Copy to avoid detaching AudioBuffer's internal memory
                    const data = audioBuffer.getChannelData(0).slice(0, Math.min(audioBuffer.length, 44100 * 30));
                    bpmWorker.postMessage({
                        audioData: data.buffer,
                        sampleRate: audioBuffer.sampleRate,
                        deckIndex: deckIndex
                    }, [data.buffer]);
                } else {
                    setTrackStatus(deckIndex, 'Ready', 'ready');
                }

                console.log(`[Deck ${deckIndex}] Loaded: ${file.name} (${audioBuffer.duration.toFixed(1)}s)`);
                updateStatus(deckIndex);
                setTrackStatus(deckIndex, 'Ready — press ▶ to play', 'ready');
            } catch (err) {
                console.error(`[Deck ${deckIndex}] Failed to decode:`, err);
                setTrackStatus(deckIndex, 'Error loading file', 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    } catch (err) {
        console.error(`[Deck ${deckIndex}] Failed to load:`, err);
        setTrackStatus(deckIndex, 'Error reading file', 'error');
    }
}

// ============================================================
// TRACKER PLAYER (MOD/MED/AHX/SID via deck-player WASM)
// ============================================================

async function loadTrackerFile(deckIndex, file) {
    const deck = state.decks[deckIndex];
    deck.deckType = 'tracker';
    setTrackStatus(deckIndex, 'Loading WASM player...');

    try {
        // Lazily load the deck-player WASM module
        if (!state.deckPlayerModule) {
            const mod = await import('./deck-player.js');
            state.deckPlayerModule = await mod.default();
            console.log('[WASM] Deck player initialized');
        }

        const mod = state.deckPlayerModule;
        deck.modModule = mod;

        // Create player instance
        deck.modPlayer = mod._deck_player_create_wasm(state.audioContext.sampleRate);
        setTrackStatus(deckIndex, 'Loading tracker file...');

        // Read file into WASM memory
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const arrayBuffer = e.target.result;
                const uint8Array = new Uint8Array(arrayBuffer);
                const memoryBuffer = mod.wasmMemory
                    ? mod.wasmMemory.buffer
                    : mod.HEAPU8.buffer;

                const dataPtr = mod._malloc(uint8Array.length);
                const heap = new Uint8Array(memoryBuffer);
                heap.set(uint8Array, dataPtr);

                const filenameBytes = new TextEncoder().encode(file.name + '\0');
                const filenamePtr = mod._malloc(filenameBytes.length);
                heap.set(filenameBytes, filenamePtr);

                const success = mod._deck_player_load_from_memory(
                    deck.modPlayer, dataPtr, uint8Array.length, filenamePtr
                );

                mod._free(dataPtr);
                mod._free(filenamePtr);

                if (!success) {
                    setTrackStatus(deckIndex, 'Failed to load tracker file', 'error');
                    return;
                }

                // Get file info
                const typeName = readCString(mod, mod._deck_player_get_type_name_wasm(deck.modPlayer));
                const title = readCString(mod, mod._deck_player_get_title_wasm(deck.modPlayer));
                const numChannels = mod._deck_player_get_num_channels_wasm(deck.modPlayer);
                const songLength = mod._deck_player_get_song_length_wasm(deck.modPlayer);
                const bpm = mod._deck_player_get_bpm_wasm(deck.modPlayer);

                deck.duration = songLength * 4; // rough estimate
                deck.bpm = bpm > 0 ? bpm : null;

                if (deck.bpm) {
                    document.getElementById(`bpm-${deckIndex}`).textContent = `${deck.bpm} BPM`;
                }

                setTrackStatus(deckIndex, `${typeName} • ${title || file.name}`, 'ready');

                // Setup audio processing node
                const bufferSize = 4096;
                deck.modBufferPtr = mod._deck_create_audio_buffer(bufferSize);
                deck.modScriptNode = state.audioContext.createScriptProcessor(bufferSize, 0, 2);

                // Zero initial buffer
                const initBuf = new Float32Array(memoryBuffer, deck.modBufferPtr, bufferSize * 2);
                initBuf.fill(0);

                deck.modScriptNode.onaudioprocess = (e) => {
                    const leftOut = e.outputBuffer.getChannelData(0);
                    const rightOut = e.outputBuffer.getChannelData(1);
                    const actualSize = leftOut.length;

                    if (!deck.playing) {
                        leftOut.fill(0); rightOut.fill(0);
                        return;
                    }

                    const memBuf = mod.wasmMemory ? mod.wasmMemory.buffer : mod.HEAPU8.buffer;
                    const audioBufferPtr = deck.modBufferPtr;

                    mod._deck_player_process_f32(deck.modPlayer, audioBufferPtr, actualSize, state.audioContext.sampleRate);

                    const audioData = new Float32Array(memBuf, audioBufferPtr, actualSize * 2);
                    for (let i = 0; i < actualSize; i++) {
                        leftOut[i] = audioData[i];
                        rightOut[i] = audioData[actualSize + i];
                    }
                };

                // Connect script node to the EQ chain
                deck.modScriptNode.connect(deck.workletNode || deck.gainNode);

                deck.playing = false;

                const detailsEl = document.getElementById(`trackerDetails-${deckIndex}`);
                if (detailsEl) {
                    detailsEl.style.display = 'flex';
                    let muteBtns = '';
                    for (let c = 0; c < numChannels; c++) {
                        muteBtns += '<button class="ch-mute" data-deck="' + deckIndex + '" data-ch="' + c +
                            '" style="width:24px;height:24px;padding:0;font-size:9px;background:#1a3a1a;border:1px solid #2a5a2a;color:#4a4;border-radius:2px;cursor:pointer">' + (c+1) + '</button>';
                    }
                    detailsEl.innerHTML = '<span style="color:#0066FF">' + typeName + '</span>' +
                        '<span>' + (title || file.name) + '</span>' +
                        '<span>' + (bpm || '?') + ' BPM</span>' +
                        '<span>' + numChannels + 'ch</span>' +
                        '<span class="tracker-pos" id="trackerPos-' + deckIndex + '">Ord:00 Pat:00 Row:000</span>' +
                        '<span class="ch-mute-row" style="display:flex;gap:2px;flex-wrap:wrap;width:100%;margin-top:2px">' + muteBtns + '</span>';
                    detailsEl.querySelectorAll('.ch-mute').forEach(btn => {
                        btn.addEventListener('click', () => {
                            const ch = parseInt(btn.dataset.ch);
                            const muted = mod._deck_player_get_channel_mute_wasm(deck.modPlayer, ch);
                            mod._deck_player_set_channel_mute_wasm(deck.modPlayer, ch, muted ? 0 : 1);
                            btn.style.background = muted ? '#1a3a1a' : '#3a1a1a';
                            btn.style.borderColor = muted ? '#2a5a2a' : '#5a2a2a';
                            btn.style.color = muted ? '#4a4' : '#a44';
                        });
                    });
                }
                updateStatus(deckIndex);
                startTrackerUI(deckIndex);
                console.log('[WASM] Loaded tracker:', typeName, '-', title || file.name, bpm + 'BPM', numChannels + 'ch');

            } catch (err) {
                console.error('[WASM] Error:', err);
                setTrackStatus(deckIndex, 'Error loading tracker', 'error');
            }
        };
        reader.readAsArrayBuffer(file);

    } catch (err) {
        console.error('[WASM] Failed to init:', err);
        setTrackStatus(deckIndex, 'WASM player unavailable', 'error');
        // Fall back to audio decode
        loadAudioFile(deckIndex, file);
    }
}

function readCString(mod, ptr) {
    if (!ptr) return '';
    const buf = mod.wasmMemory ? mod.wasmMemory.buffer : mod.HEAPU8.buffer;
    const heap8 = new Uint8Array(buf);
    const bytes = [];
    let i = 0;
    while (heap8[ptr + i] !== 0) { bytes.push(heap8[ptr + i]); i++; }
    return new TextDecoder().decode(new Uint8Array(bytes));
}

function cleanupModPlayer(deckIndex) {
    const deck = state.decks[deckIndex];
    if (deck.trackerRAF) { cancelAnimationFrame(deck.trackerRAF); deck.trackerRAF = null; }
    const detailsEl = document.getElementById(`trackerDetails-${deckIndex}`);
    if (detailsEl) detailsEl.style.display = 'none';
    if (deck.modScriptNode) {
        deck.modScriptNode.disconnect();
        deck.modScriptNode = null;
    }
    if (deck.modPlayer && deck.modModule) {
        deck.modModule._deck_player_stop_wasm(deck.modPlayer);
        deck.modModule._deck_player_destroy_wasm(deck.modPlayer);
        deck.modPlayer = null;
    }
    deck.deckType = 'audio';
    deck.playing = false;
    deck.looping = false;
    deck.loopStart = -1;
    deck.loopEnd = -1;
    deck._trackerSeekOrder = -1;
    deck._visualOrder = -1;
    const loopBtn = document.getElementById(`loop-${deckIndex}`);
    if (loopBtn) loopBtn.classList.remove('active');
}

function startTrackerUI(deckIndex) {
    const deck = state.decks[deckIndex];
    const mod = deck.modModule;
    const songLen = mod._deck_player_get_song_length_wasm(deck.modPlayer);

    const ROWS_PER_PAT = 64;

    function drawOrderMarkers() {
        const canvas = document.getElementById(`waveformCanvas-${deckIndex}`);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const w = canvas.parentElement.clientWidth || 300;
        canvas.width = w;
        const h = canvas.height;

        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, w, h);

        if (!deck.modPlayer || !deck.modModule) return;
        const curOrder = mod._deck_player_get_current_order(deck.modPlayer);
        const curRow = mod._deck_player_get_current_row(deck.modPlayer);

        if (songLen > 0) {
            const step = w / songLen;

            for (let i = 0; i < songLen; i++) {
                const x = i * step;

                if (i === curOrder) {
                    const progress = Math.min(1, (curRow || 0) / ROWS_PER_PAT);
                    if (deck.looping) {
                        // Pure yellow highlight for pattern loop
                        ctx.fillStyle = 'rgba(207, 180, 26, 0.25)';
                        ctx.fillRect(x, 0, step, h);
                        ctx.fillStyle = 'rgba(207, 180, 26, 0.45)';
                        ctx.fillRect(x, 0, step * progress, h);
                    } else {
                        // Red highlight for normal playback
                        ctx.fillStyle = 'rgba(207, 26, 55, 0.3)';
                        ctx.fillRect(x, 0, step, h);
                        ctx.fillStyle = 'rgba(207, 26, 55, 0.5)';
                        ctx.fillRect(x, 0, step * progress, h);
                    }
                }

                const lineX = x;
                ctx.strokeStyle = i === curOrder ? (deck.looping ? '#CFB41A' : '#CF1A37') : '#444';
                ctx.lineWidth = i === curOrder ? 2 : 1;
                ctx.beginPath();
                ctx.moveTo(lineX, 0);
                ctx.lineTo(lineX, h);
                ctx.stroke();
            }

            // Playhead line at the progress position within the current block
            if (curOrder >= 0 && curOrder < songLen) {
                const progress = Math.min(1, (curRow || 0) / ROWS_PER_PAT);
                const playheadX = curOrder * step + step * progress;
                ctx.strokeStyle = deck.looping ? '#CFB41A' : '#CF1A37';
                ctx.lineWidth = 1;
                ctx.setLineDash([2, 2]);
                ctx.beginPath();
                ctx.moveTo(playheadX, 0);
                ctx.lineTo(playheadX, h);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Blue enqueued jump indicator — fill entire target block
            if (deck.looping && deck._visualOrder >= 0 && deck._visualOrder !== curOrder) {
                const bx = deck._visualOrder * step;
                ctx.fillStyle = 'rgba(26, 100, 207, 0.35)';
                ctx.fillRect(bx, 0, step, h);
            }

            // Label at bottom — just order count, no row (shown in trackerPos)
            ctx.fillStyle = '#aaa';
            ctx.font = '9px monospace';
            ctx.fillText('Ord:' + curOrder + '/' + (songLen - 1), 4, h - 4);
        }
    }

    // Click to seek or set loop range
    const canvas = document.getElementById(`waveformCanvas-${deckIndex}`);
    if (canvas) {
        canvas.style.cursor = 'pointer';
        canvas.onclick = (e) => {
            if (!deck.modPlayer || !deck.modModule || songLen <= 0) return;
            const rect = canvas.getBoundingClientRect();
            const frac = (e.clientX - rect.left) / rect.width;
            const targetOrder = Math.min(Math.floor(frac * songLen), songLen - 1);

            deck._trackerSeekOrder = targetOrder;
            if (deck.looping && typeof mod._deck_player_queue_jump_wasm !== 'undefined') {
                const songLen = mod._deck_player_get_song_length_wasm(deck.modPlayer);
                deck._visualOrder = targetOrder;
                mod._deck_player_set_loop_range_wasm(deck.modPlayer, 0, songLen - 1);
                mod._deck_player_queue_jump_wasm(deck.modPlayer, targetOrder, 0);
            } else {
                if (deck.looping) {
                    mod._deck_player_set_loop_range_wasm(deck.modPlayer, targetOrder, targetOrder);
                }
                mod._deck_player_set_position_wasm(deck.modPlayer, targetOrder, 0);
                deck._visualOrder = -1;
            }
        };
    }

    function update() {
        if (!deck.modPlayer || !deck.modModule) return;
        const order = mod._deck_player_get_current_order(deck.modPlayer);
        const pattern = mod._deck_player_get_current_pattern(deck.modPlayer);
        const row = mod._deck_player_get_current_row(deck.modPlayer);
        const bpm = mod._deck_player_get_bpm_wasm(deck.modPlayer);
        // Clear visual order when the queue callback fires (position reaches target)
        if (deck._visualOrder >= 0 && order === deck._visualOrder) {
            deck._visualOrder = -1;
        }
        const el = document.getElementById(`trackerPos-${deckIndex}`);
        if (el) {
            el.textContent = 'Ord:' + String(order).padStart(2,'0') +
                ' Pat:' + String(pattern).padStart(2,'0') +
                ' Row:' + String(row).padStart(3,'0') +
                ' ' + bpm + 'BPM';
        }
        drawOrderMarkers();
        deck.trackerRAF = requestAnimationFrame(update);
    }
    drawOrderMarkers();
    if (deck.trackerRAF) cancelAnimationFrame(deck.trackerRAF);
    deck.trackerRAF = requestAnimationFrame(update);
}

function playDeck(deckIndex) {
    const deck = state.decks[deckIndex];
    const ctx = state.audioContext;

    if (ctx.state === 'suspended') ctx.resume();
    if (deck.source) {
        try { deck.source.stop(); } catch(e) {}
        deck.source.disconnect();
        deck.source = null;
    }
    if (!deck.track) return;

    // Restore gain (was muted by stopDeck to prevent bleed)
    if (deck.gainNode) deck.gainNode.gain.value = deck.volume / 127;

    deck.source = ctx.createBufferSource();
    deck.source.buffer = deck.track;
    deck.source.loop = deck.looping;

    // Route through WASM effects
    if (!deck.workletNode) {
        console.error('[WASM] Not available — cannot play');
        return;
    }
    deck.source.connect(deck.workletNode);

    const offset = deck.isPaused ? deck.pausedAt : 0;
    deck.startOffset = offset;
    deck.source.start(0, offset);
    deck.isPaused = false;
    deck.playing = true;
    deck.startTime = ctx.currentTime - offset;

    document.getElementById(`play-${deckIndex}`).textContent = '⏸';
    document.getElementById(`play-${deckIndex}`).classList.add('active');
    updateStatus(deckIndex);
    startWaveformAnimation(deckIndex);
    console.log(`[Deck ${deckIndex}] Playing from ${offset.toFixed(1)}s`);
}

function stopDeck(deckIndex) {
    const deck = state.decks[deckIndex];

    // Mute gain immediately to prevent audio bleed
    if (deck.gainNode) deck.gainNode.gain.value = 0;

    // Stop WASM tracker player
    if (deck.modPlayer && deck.modModule) {
        deck.modModule._deck_player_stop_wasm(deck.modPlayer);
        deck.playing = false;
    }

    // Stop Web Audio source
    if (deck.source) {
        try { deck.source.stop(); } catch(e) {}
        deck.source.disconnect();
        deck.source = null;
    }
    deck.track = null;
    deck.playing = false;
    deck.isPaused = false;
    deck.pausedAt = 0;
    deck.startOffset = 0;
    deck.currentTime = 0;

    document.getElementById(`play-${deckIndex}`).textContent = '▶';
    document.getElementById(`play-${deckIndex}`).classList.remove('active');
    document.getElementById(`cue-${deckIndex}`).classList.remove('active');
    deck.cueing = false;
    updateTimeDisplay(deckIndex);
    updateStatus(deckIndex);
    stopWaveformAnimation(deckIndex);
}

function seekDeck(deckIndex, fraction) {
    const deck = state.decks[deckIndex];
    if (!deck.track) return;
    const pos = Math.max(0, Math.min(1, fraction)) * (deck.duration || 1);
    const wasPlaying = deck.playing;
    if (deck.source) { try { deck.source.stop(); } catch(e) {} deck.source.disconnect(); deck.source = null; }
    deck.playing = false; deck.isPaused = true; deck.pausedAt = pos; deck.currentTime = pos;
    if (wasPlaying) playDeck(deckIndex);
    updateTimeDisplay(deckIndex);
}

function setPitch(deckIndex, value) {
    const deck = state.decks[deckIndex];
    const mv = Math.round(value);
    const pitch = 0.5 + (mv / 127) * 1.0;
    deck.pitch = pitch;
    if (deck.source && deck.source.playbackRate) deck.source.playbackRate.value = pitch;
    const ve = document.getElementById(`pitchVal-${deckIndex}`);
    if (ve) { const st = Math.round((pitch - 1) * 12); ve.textContent = st > 0 ? `+${st}st` : st === 0 ? '0st' : `${st}st`; }
    const th = document.getElementById(`pitchThumb-${deckIndex}`);
    if (th) { const p = th.parentElement; if (p) { th.style.top = `${Math.round((p.offsetHeight - th.offsetHeight) * (1 - mv / 127))}px`; } }
}

async function togglePlay(deckIndex) {
    const deck = state.decks[deckIndex];

    // Tracker file playback
    if (deck.modPlayer) {
        if (state.audioContext.state === 'suspended') await state.audioContext.resume();
        if (deck.playing) {
            deck.playing = false;
            // Freeze visual position at last known WASM position
            const lastOrder = deck.modModule._deck_player_get_current_order(deck.modPlayer);
            const lastRow = deck.modModule._deck_player_get_current_row(deck.modPlayer);
            deck._visualOrder = lastOrder;
            deck._visualRow = lastRow;
            deck.modModule._deck_player_stop_wasm(deck.modPlayer);
            document.getElementById(`play-${deckIndex}`).textContent = '▶';
            document.getElementById(`play-${deckIndex}`).classList.remove('active');
        } else {
            deck.playing = true;
            // Restore gain (was muted by stopDeck)
            if (deck.gainNode) deck.gainNode.gain.value = deck.volume / 127;
            deck.modModule._deck_player_start_wasm(deck.modPlayer);
            // Apply pending seek (canvas click before play — start_wasm resets to 0)
            if (deck._trackerSeekOrder !== undefined && deck._trackerSeekOrder >= 0) {
                deck.modModule._deck_player_set_position_wasm(deck.modPlayer, deck._trackerSeekOrder, 0);
            }
            // Clear visual position — WASM live values take over during playback
            deck._visualOrder = -1;
            deck._trackerSeekOrder = -1;
            deck._trackerSeekRow = 0;
            document.getElementById(`play-${deckIndex}`).textContent = '⏸';
            document.getElementById(`play-${deckIndex}`).classList.add('active');
        }
        updateStatus(deckIndex);
        return;
    }

    // Regular audio playback
    if (!deck.track) return;

    if (deck.playing) {
        deck.pausedAt = (state.audioContext.currentTime - deck.startTime);
        deck.isPaused = true;
        deck.playing = false;
        if (deck.source) {
            try { deck.source.stop(); } catch(e) {}
            deck.source.disconnect();
            deck.source = null;
        }
        document.getElementById(`play-${deckIndex}`).textContent = '▶';
        document.getElementById(`play-${deckIndex}`).classList.remove('active');
        stopWaveformAnimation(deckIndex);
    } else {
        playDeck(deckIndex);
    }
    updateStatus(deckIndex);
}

function toggleCue(deckIndex) {
    const deck = state.decks[deckIndex];
    if (!deck.track) return;

    if (deck.cueing) {
        deck.cueing = false;
        document.getElementById(`cue-${deckIndex}`).classList.remove('active');
        if (deck.wasPlayingBeforeCue) {
            playDeck(deckIndex);
        } else {
            if (deck.source) {
                try { deck.source.stop(); } catch(e) {}
                deck.source.disconnect();
                deck.source = null;
            }
            deck.playing = false;
            deck.isPaused = false;
            deck.pausedAt = 0;
            updateStatus(deckIndex);
        }
    } else {
        deck.wasPlayingBeforeCue = deck.playing;
        if (deck.playing) {
            if (deck.source) {
                try { deck.source.stop(); } catch(e) {}
                deck.source.disconnect();
                deck.source = null;
            }
            deck.playing = false;
            deck.isPaused = true;
            deck.pausedAt = (state.audioContext.currentTime - deck.startTime);
        }
        deck.cueing = true;
        document.getElementById(`cue-${deckIndex}`).classList.add('active');

        const previewDuration = 0.1;
        const cueOffset = deck.isPaused ? deck.pausedAt : 0;
        const cueSource = state.audioContext.createBufferSource();
        cueSource.buffer = deck.track;
        if (!deck.workletNode) return;
        cueSource.connect(deck.workletNode);
        cueSource.start(0, cueOffset, previewDuration);
        setTimeout(() => {
            try { cueSource.stop(); } catch(e) {}
            cueSource.disconnect();
        }, (previewDuration * 1000) + 50);
    }
    updateStatus(deckIndex);
}

function toggleSync(deckIndex) {
    const deck = state.decks[deckIndex];
    const otherIdx = deckIndex === 0 ? 1 : 0;
    const other = state.decks[otherIdx];
    const mod = deck.modModule;
    const oMod = other.modModule;

    // Tracker: sync position (order + row) from the other deck
    if (deck.modPlayer && mod && oMod && oMod._deck_player_get_current_order) {
        const oOrder = oMod._deck_player_get_current_order(other.modPlayer);
        const oRow = oMod._deck_player_get_current_row(other.modPlayer);
        mod._deck_player_set_position_wasm(deck.modPlayer, oOrder, oRow);
        console.log(`[Deck ${deckIndex}] Synced to Deck ${otherIdx} order ${oOrder} row ${oRow}`);
    }

    // BPM sync (for both tracker and audio files)
    if (other.bpm && other.bpm > 0) {
        deck.bpm = other.bpm;
        document.getElementById(`bpm-${deckIndex}`).textContent = `${other.bpm} BPM`;
        console.log(`[Deck ${deckIndex}] BPM synced: ${other.bpm}`);
    }

    deck.synced = true;
    document.getElementById(`sync-${deckIndex}`).classList.add('active');
    setTimeout(() => {
        deck.synced = false;
        document.getElementById(`sync-${deckIndex}`).classList.remove('active');
    }, 500);
}

function trackerPrevPattern(deckIndex) {
    const deck = state.decks[deckIndex];
    if (!deck.modPlayer || !deck.modModule) return;
    const mod = deck.modModule;
    const songLen = mod._deck_player_get_song_length_wasm(deck.modPlayer);
    const base = (deck._visualOrder >= 0) ? deck._visualOrder : mod._deck_player_get_current_order(deck.modPlayer);
    const target = base <= 0 ? songLen - 1 : base - 1;
    deck._visualOrder = target;
    if (deck.looping && typeof mod._deck_player_queue_jump_wasm !== 'undefined') {
        mod._deck_player_set_loop_range_wasm(deck.modPlayer, 0, songLen - 1);
        mod._deck_player_queue_jump_wasm(deck.modPlayer, target, 0);
    } else {
        mod._deck_player_prev_pattern(deck.modPlayer);
    }
}

function trackerNextPattern(deckIndex) {
    const deck = state.decks[deckIndex];
    if (!deck.modPlayer || !deck.modModule) return;
    const mod = deck.modModule;
    const songLen = mod._deck_player_get_song_length_wasm(deck.modPlayer);
    const base = (deck._visualOrder >= 0) ? deck._visualOrder : mod._deck_player_get_current_order(deck.modPlayer);
    const target = (base + 1) % songLen;
    deck._visualOrder = target;
    if (deck.looping && typeof mod._deck_player_queue_jump_wasm !== 'undefined') {
        mod._deck_player_set_loop_range_wasm(deck.modPlayer, 0, songLen - 1);
        mod._deck_player_queue_jump_wasm(deck.modPlayer, target, 0);
    } else {
        mod._deck_player_next_pattern(deck.modPlayer);
    }
}

function toggleLoop(deckIndex) {
    const deck = state.decks[deckIndex];
    deck.looping = !deck.looping;
    document.getElementById(`loop-${deckIndex}`).classList.toggle('active');

    // Tracker pattern loop — controller manages this
    if (deck.modPlayer && deck.modModule) {
        const mod = deck.modModule;
        if (typeof mod._deck_player_set_pattern_mode_wasm !== 'undefined') {
            mod._deck_player_set_pattern_mode_wasm(deck.modPlayer, deck.looping ? 1 : 0);
        }
        console.log(`[Deck ${deckIndex}] Pattern loop: ${deck.looping ? 'ON' : 'OFF'}`);
        return;
    }

    // Regular audio loop
    if (deck.source && deck.playing) {
        deck.source.loop = deck.looping;
    }
    console.log(`[Deck ${deckIndex}] Loop ${deck.looping ? 'ON' : 'OFF'}`);
}

// ============================================================
// EQ, FILTER, FADER, CROSSFADER
// ============================================================
function setEQ(deckIndex, band, value) {
    const deck = state.decks[deckIndex];
    const midiValue = Math.round(value);
    if (midiValue < 0 || midiValue > 127) return;

    deck.eq[band] = midiValue;
    const normalized = midiValue / 127;

    // AudioWorklet mode: send via message port
    const wn = deck.workletNode;
    if (wn && wn.port && deck.audioMode === 'worklet') {
        const p = band === 'hi' ? 'high' : band;
        wn.port.postMessage({ type: 'setParam', data: { effect: 'eq', param: p, value: normalized } });
    }

    // ScriptProcessor mode: direct WASM call
    const ef = deck.wasmEffects && deck.wasmEffects.eq;
    if (ef && ef.ptr) {
        const p = band === 'hi' ? 'high' : band;
        deck.wasmModule[ef.prefix + '_set_' + p](ef.ptr, normalized);
    }

    const bandUpper = band.charAt(0).toUpperCase() + band.slice(1);
    const knob = document.getElementById(`eqKnob-${bandUpper}-${deckIndex}`);
    if (knob) knob.setAttribute('value', midiValue);
}

function setFilter(deckIndex, value) {
    const deck = state.decks[deckIndex];
    const midiValue = Math.round(value);
    if (midiValue < 0 || midiValue > 127) return;

    deck.filter = midiValue;
    const normalized = midiValue / 127;

    // AudioWorklet mode: send via message port
    const wn = deck.workletNode;
    if (wn && wn.port && deck.audioMode === 'worklet') {
        wn.port.postMessage({ type: 'setParam', data: { effect: 'filter', param: 'cutoff', value: normalized } });
        wn.port.postMessage({ type: 'setParam', data: { effect: 'filter', param: 'resonance', value: 0 } });
    }

    // ScriptProcessor mode: direct WASM call
    const ef = deck.wasmEffects && deck.wasmEffects.filter;
    if (ef && ef.ptr) {
        deck.wasmModule[ef.prefix + '_set_cutoff'](ef.ptr, normalized);
        deck.wasmModule[ef.prefix + '_set_resonance'](ef.ptr, 0);
    }

    const knob = document.getElementById(`eqKnob-Filter-${deckIndex}`);
    if (knob) knob.setAttribute('value', midiValue);
}

function setFader(deckIndex, value) {
    const deck = state.decks[deckIndex];
    const midiValue = Math.round(value);
    if (midiValue < 0 || midiValue > 127) return;

    deck.volume = midiValue;
    if (deck.gainNode) deck.gainNode.gain.value = midiValue / 127;

    const thumb = document.getElementById(`faderThumb-${deckIndex}`);
    if (thumb) {
        const track = thumb.parentElement;
        if (track) {
            const trackH = track.offsetHeight;
            const thumbH = thumb.offsetHeight;
            const maxTop = trackH - thumbH;
            const top = maxTop * (1 - midiValue / 127);
            thumb.style.top = `${Math.round(top)}px`;
        }
    }
    const valEl = document.getElementById(`faderVal-${deckIndex}`);
    if (valEl) valEl.textContent = `${Math.round((midiValue / 127) * 100)}%`;
}

function setCrossfader(value) {
    const midiValue = Math.round(value);
    if (midiValue < 0 || midiValue > 127) return;

    state.crossfader = midiValue;
    updateCrossfader(midiValue);

    const thumb = document.getElementById('crossfaderThumb');
    if (thumb) {
        const track = thumb.parentElement;
        if (track) {
            const trackW = track.offsetWidth;
            const thumbW = thumb.offsetWidth;
            const maxLeft = trackW - thumbW;
            thumb.style.left = `${Math.round(maxLeft * (midiValue / 127))}px`;
        }
    }
    const valEl = document.getElementById('crossfaderVal');
    if (valEl) {
        if (midiValue < 56) valEl.textContent = 'A';
        else if (midiValue > 72) valEl.textContent = 'B';
        else valEl.textContent = 'Center';
    }
}

function updateCrossfader(value) {
    const normalized = value / 127;
    const gainA = Math.cos((normalized * Math.PI) / 2);
    const gainB = Math.sin((normalized * Math.PI) / 2);
    if (state.crossfaderGain.a) state.crossfaderGain.a.gain.value = gainA * gainA;
    if (state.crossfaderGain.b) state.crossfaderGain.b.gain.value = gainB * gainB;
}

// ============================================================
// WAVEFORM & BPM
// ============================================================
function generateWaveform(deckIndex, audioBuffer) {
    const canvas = document.getElementById(`waveformCanvas-${deckIndex}`);
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const data = audioBuffer.getChannelData(0);
    const width = canvas.parentElement.clientWidth;
    canvas.width = width;
    const amp = canvas.height / 2;

    ctx.clearRect(0, 0, width, canvas.height);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, width, canvas.height);

    ctx.beginPath();
    ctx.strokeStyle = deckIndex === 0 ? '#ff4444' : '#4488ff';
    ctx.lineWidth = 1.5;

    const step = Math.floor(data.length / width);
    for (let i = 0; i < width; i++) {
        let min = 1.0, max = -1.0;
        for (let j = 0; j < step; j++) {
            const datum = data[(i * step) + j];
            if (datum < min) min = datum;
            if (datum > max) max = datum;
        }
        ctx.moveTo(i, (1 + min) * amp);
        ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();

    state.decks[deckIndex].waveformData = { width, step };
    startWaveformAnimation(deckIndex);

    // Click on waveform to seek
    canvas.style.cursor = 'pointer';
    canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        seekDeck(deckIndex, (e.clientX - rect.left) / rect.width);
    });
}

function startWaveformAnimation(deckIndex) {
    const deck = state.decks[deckIndex];
    if (state.waveformAnimIds[deckIndex]) return;

    function animate() {
        const canvas = document.getElementById(`waveformCanvas-${deckIndex}`);
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const amp = height / 2;

        const currentTime = getDeckTime(deckIndex);
        const progress = deck.duration > 0 ? currentTime / deck.duration : 0;

        ctx.clearRect(0, 0, width, height);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(0, 0, width, height);

        if (deck.track) {
            const data = deck.track.getChannelData(0);
            const step = Math.floor(data.length / width);
            ctx.beginPath();
            ctx.strokeStyle = deckIndex === 0 ? '#ff4444' : '#4488ff';
            ctx.lineWidth = 1.5;
            for (let i = 0; i < width; i++) {
                let min = 1.0, max = -1.0;
                for (let j = 0; j < step; j++) {
                    const datum = data[(i * step) + j];
                    if (datum < min) min = datum;
                    if (datum > max) max = datum;
                }
                ctx.moveTo(i, (1 + min) * amp);
                ctx.lineTo(i, (1 + max) * amp);
            }
            ctx.stroke();

            const playheadX = progress * width;
            ctx.fillStyle = 'rgba(207, 26, 55, 0.3)';
            ctx.fillRect(0, 0, playheadX, height);
            ctx.beginPath();
            ctx.strokeStyle = '#CF1A37';
            ctx.lineWidth = 2;
            ctx.moveTo(playheadX, 0);
            ctx.lineTo(playheadX, height);
            ctx.stroke();
        }

        updateTimeDisplay(deckIndex);
        state.waveformAnimIds[deckIndex] = requestAnimationFrame(animate);
    }
    state.waveformAnimIds[deckIndex] = requestAnimationFrame(animate);
}

function stopWaveformAnimation(deckIndex) {
    if (state.waveformAnimIds[deckIndex]) {
        cancelAnimationFrame(state.waveformAnimIds[deckIndex]);
        state.waveformAnimIds[deckIndex] = null;
    }
}

function getDeckTime(deckIndex) {
    const deck = state.decks[deckIndex];
    if (deck.playing && state.audioContext) {
        deck.currentTime = state.audioContext.currentTime - deck.startTime;
    }
    return deck.currentTime;
}

function updateTimeDisplay(deckIndex) {
    const deck = state.decks[deckIndex];
    const current = getDeckTime(deckIndex);
    const total = deck.duration || 0;
    const fmt = (t) => {
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };
    document.getElementById(`currentTime-${deckIndex}`).textContent = fmt(current);
    document.getElementById(`totalTime-${deckIndex}`).textContent = fmt(total);
}

// ============================================================
// JOG WHEEL
// ============================================================
function setupJogWheel(deckIndex) {
    const container = document.getElementById(`jog-${deckIndex}`);
    const canvas = document.getElementById(`jogCanvas-${deckIndex}`);
    const ctx = canvas.getContext('2d');

    let isDragging = false;
    let lastAngle = 0;
    let totalRotation = 0;

    function drawJog(angle) {
        const w = canvas.width;
        const h = canvas.height;
        const cx = w / 2;
        const cy = h / 2;
        const r = Math.min(cx, cy) - 10;

        ctx.clearRect(0, 0, w, h);

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = deckIndex === 0 ? '#ff4444' : '#4488ff';
        ctx.lineWidth = 3;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.85, 0, Math.PI * 2);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 1;
        ctx.stroke();

        const numTicks = 24;
        for (let i = 0; i < numTicks; i++) {
            const theta = (i / numTicks) * Math.PI * 2 + angle;
            const outerR = r - 5;
            const innerR = r * 0.85 + 3;
            ctx.beginPath();
            ctx.moveTo(cx + Math.cos(theta) * innerR, cy + Math.sin(theta) * innerR);
            ctx.lineTo(cx + Math.cos(theta) * outerR, cy + Math.sin(theta) * outerR);
            ctx.strokeStyle = i === 0 ? '#CF1A37' : '#555';
            ctx.lineWidth = i === 0 ? 3 : 1.5;
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(cx, cy, r * 0.4, 0, Math.PI * 2);
        ctx.fillStyle = '#1a1a1a';
        ctx.fill();
        ctx.strokeStyle = '#444';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle = '#666';
        ctx.fill();

        const indicatorAngle = angle;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(indicatorAngle) * (r * 0.35),
                    cy + Math.sin(indicatorAngle) * (r * 0.35));
        ctx.strokeStyle = '#CF1A37';
        ctx.lineWidth = 2;
        ctx.stroke();
    }

    function getAngle(e) {
        const rect = container.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return Math.atan2(clientY - cy, clientX - cx);
    }

    function handleStart(e) {
        e.preventDefault();
        isDragging = true;
        lastAngle = getAngle(e);
    }

    function handleMove(e) {
        if (!isDragging) return;
        e.preventDefault();
        const angle = getAngle(e);
        let delta = angle - lastAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        totalRotation += delta;
        const jogAngle = totalRotation;
        state.decks[deckIndex].jogAngle = jogAngle;
        drawJog(jogAngle);

        // Scrub: each full rotation = 16 rows (tracker) or 5% (audio)
        const deck = state.decks[deckIndex];
        if (deck.modPlayer && deck.modModule) {
            const mod = deck.modModule;
            const rows = Math.round((delta / (Math.PI * 2)) * 16);
            if (rows !== 0) {
                const curOrder = mod._deck_player_get_current_order(deck.modPlayer);
                const curRow = mod._deck_player_get_current_row(deck.modPlayer);
                let newRow = curRow + rows;
                let newOrder = curOrder;
                const rpp = 64;
                while (newRow < 0) { newOrder--; newRow += rpp; }
                while (newRow >= rpp) { newOrder++; newRow -= rpp; }
                if (newOrder >= 0) {
                    const sl = mod._deck_player_get_song_length_wasm(deck.modPlayer);
                    if (newOrder < sl)
                        mod._deck_player_set_position_wasm(deck.modPlayer, newOrder, newRow);
                }
            }
        } else if (deck.track && deck.duration > 0) {
            const frac = (delta / (Math.PI * 2)) * 0.02;
            const cur = (deck.currentTime || 0) / deck.duration;
            seekDeck(deckIndex, Math.max(0, Math.min(1, cur + frac)));
        }

        lastAngle = angle;
    }

    function handleEnd(e) {
        e.preventDefault();
        isDragging = false;
    }

    container.addEventListener('mousedown', handleStart);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    container.addEventListener('touchstart', handleStart, { passive: false });
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);

    drawJog(0);

    function animateJog() {
        if (!isDragging) {
            state.decks[deckIndex].jogAngle *= 0.95;
            if (Math.abs(state.decks[deckIndex].jogAngle) < 0.001) {
                state.decks[deckIndex].jogAngle = 0;
            }
            drawJog(state.decks[deckIndex].jogAngle);
        }
        state.jogAnimIds[deckIndex] = requestAnimationFrame(animateJog);
    }
    state.jogAnimIds[deckIndex] = requestAnimationFrame(animateJog);
}

// ============================================================
// MIDI ENGINE
// ============================================================
async function initMIDI() {
    console.log('[MIDI] Initializing...');
    try {
        if (!navigator.requestMIDIAccess) {
            console.warn('[MIDI] WebMIDI not supported');
            document.getElementById('midiStatusText').textContent = 'No WebMIDI';
            document.getElementById('midiMonitorStatus').innerHTML = 'MIDI: <span class="disconnected">No WebMIDI</span>';
            return;
        }

        state.midiAccess = await navigator.requestMIDIAccess();
        console.log('[MIDI] Access granted');

        state.midiAccess.onstatechange = handleMIDIStateChange;
        updateMIDIDeviceList();

        document.getElementById('midiStatusText').textContent = 'Ready';
        document.getElementById('midiMonitorStatus').innerHTML = 'MIDI: <span class="connected">Ready</span>';

        const outputs = Array.from(state.midiAccess.outputs.values());
        const inputs = Array.from(state.midiAccess.inputs.values());

        if (outputs.length > 0) {
            state.midiOutput = outputs[0];
            console.log('[MIDI] Auto-connected output:', outputs[0].name);
        }
        if (inputs.length > 0) {
            connectMIDIInput(inputs[0]);
            console.log('[MIDI] Auto-connected input:', inputs[0].name);
        }

        const dot = document.getElementById('midiStatusDot');
        if (state.midiInput) {
            dot.className = 'status-dot connected';
            document.getElementById('midiStatusText').textContent = state.midiInput.name || 'Connected';
        } else {
            dot.className = 'status-dot';
        }

    } catch (err) {
        console.error('[MIDI] Failed:', err);
        document.getElementById('midiStatusText').textContent = 'Error';
    }
}

function handleMIDIStateChange(e) {
    console.log('[MIDI] State changed:', e.port.name, e.port.state, e.port.type);
    updateMIDIDeviceList();
}

function updateMIDIDeviceList() {
    const select = document.getElementById('midiDeviceSelect');
    if (!select || !state.midiAccess) return;

    select.innerHTML = '<option value="">No Device</option>';
    for (const output of state.midiAccess.outputs.values()) {
        const opt = document.createElement('option');
        opt.value = output.id;
        opt.textContent = `📤 ${output.name}`;
        select.appendChild(opt);
    }
    for (const input of state.midiAccess.inputs.values()) {
        const opt = document.createElement('option');
        opt.value = input.id;
        opt.textContent = `📥 ${input.name}`;
        select.appendChild(opt);
    }
}

function connectMIDI() {
    const select = document.getElementById('midiDeviceSelect');
    const deviceId = select.value;
    if (!deviceId) {
        if (state.midiInput) { state.midiInput.onmidimessage = null; state.midiInput = null; }
        state.midiOutput = null;
        document.getElementById('midiStatusDot').className = 'status-dot';
        document.getElementById('midiStatusText').textContent = 'No MIDI';
        return;
    }

    let device = state.midiAccess.inputs.get(deviceId);
    if (device) { connectMIDIInput(device); return; }

    device = state.midiAccess.outputs.get(deviceId);
    if (device) {
        state.midiOutput = device;
        console.log('[MIDI] Connected output:', device.name);
        document.getElementById('midiStatusDot').className = 'status-dot connected';
        document.getElementById('midiStatusText').textContent = device.name;
    }
}

function connectMIDIInput(input) {
    if (state.midiInput) state.midiInput.onmidimessage = null;
    state.midiInput = input;
    state.midiInput.onmidimessage = handleMIDIMessage;

    console.log('[MIDI] Connected input:', input.name);
    document.getElementById('midiStatusDot').className = 'status-dot connected';
    document.getElementById('midiStatusText').textContent = input.name;

    if (!state.midiOutput) {
        for (const output of state.midiAccess.outputs.values()) {
            if (output.name === input.name) { state.midiOutput = output; break; }
        }
    }
    addMidiLog(`Connected to ${input.name}`, 'info');
}

// ============================================================
// MIDI MESSAGE HANDLING
// ============================================================
function handleMIDIMessage(event) {
    const data = event.data;
    if (!data || data.length < 2) return;

    const status = data[0];
    const messageType = status & 0xF0;
    const channel = status & 0x0F;
    const data1 = data[1] & 0x7F;
    const data2 = data.length > 2 ? (data[2] & 0x7F) : 0;

    // MIDI Learn mode
    if (state.isLearning && state.midiLearnTarget) {
        if (messageType === 0xB0 || messageType === 0x90 || messageType === 0x80) {
            learnMIDIMessage(state.midiLearnTarget, messageType, channel, data1);
            return;
        }
    }

    // Log (skip CC if filtered)
    const filterCC = document.getElementById('filterMidiLog')?.checked;
    if (!(messageType === 0xB0 && filterCC)) {
        addMidiLogMessage(messageType, channel, data1, data2);
    }

    // Look up in active profile's MIDI lookup table
    processMIDIMessage(messageType, channel, data1, data2);
}

function processMIDIMessage(messageType, channel, data1, data2) {
    if (!state.midiLookup) return;

    const isCC = messageType === 0xB0;
    const isNoteOn = messageType === 0x90 && data2 > 0;
    const isNoteOff = messageType === 0x80 || (messageType === 0x90 && data2 === 0);

    const prefix = isCC ? 'cc' : 'note';
    const key = `ch${channel}_${prefix}${data1}`;
    const entry = state.midiLookup[key];

    if (!entry) return;

    const { control, deckId } = entry;
    const value = isCC ? data2 : (isNoteOn ? 127 : 0);

    // Route to the right handler
    routeMIDIControl(control, deckId, value, isNoteOn, isNoteOff);
}

function routeMIDIControl(control, deckId, value, isNoteOn, isNoteOff) {
    switch (control.id) {
        case 'eqHi':    setEQ(deckId, 'hi', value); break;
        case 'eqMid':   setEQ(deckId, 'mid', value); break;
        case 'eqLow':   setEQ(deckId, 'low', value); break;
        case 'filter':  setFilter(deckId, value); break;
        case 'fader':   setFader(deckId, value); break;
        case 'crossfader': setCrossfader(value); break;
        case 'play':
            if (isNoteOn) togglePlay(deckId);
            break;
        case 'cue':
            if (isNoteOn) toggleCue(deckId);
            break;
        case 'sync':
            if (isNoteOn) toggleSync(deckId);
            break;
        case 'loop':
            if (isNoteOn) toggleLoop(deckId);
            break;
        default:
            console.log(`[MIDI] Unknown control id: ${control.id}`);
    }
}

// ============================================================
// MIDI LEARN
// ============================================================
function enterMidiLearn(target) {
    state.isLearning = true;
    state.midiLearnTarget = target;

    document.getElementById('midiStatusDot').className = 'status-dot learning';
    document.getElementById('midiStatusText').textContent = 'LEARN';
    document.getElementById('midiLearnStatus').innerHTML = 'Move a control on your MIDI device...';
    addMidiLog(`MIDI Learn: waiting for "${target.label}"`, 'info');
}

function exitMidiLearn() {
    state.isLearning = false;
    state.midiLearnTarget = null;
    const dot = document.getElementById('midiStatusDot');
    if (state.midiInput) {
        dot.className = 'status-dot connected';
        document.getElementById('midiStatusText').textContent = state.midiInput.name;
    } else {
        dot.className = 'status-dot';
        document.getElementById('midiStatusText').textContent = 'No MIDI';
    }
}

function learnMIDIMessage(target, messageType, channel, data1) {
    const isCC = messageType === 0xB0;
    const isNote = messageType === 0x90 || messageType === 0x80;

    if (!isCC && !isNote) {
        document.getElementById('midiLearnStatus').textContent =
            `❌ Unsupported message type (0x${messageType.toString(16)})`;
        return;
    }

    setControlOverride(target.controlKey, messageType, channel, data1);

    const msgType = isCC ? `CC ${data1}` : `Note ${data1}`;
    document.getElementById('midiLearnStatus').innerHTML =
        `✅ Assigned! <strong>${target.label}</strong> → Ch ${channel + 1} ${msgType}`;

    showCurrentMidiMapping();
    addMidiLog(`MIDI Learn: ${target.label} → Ch${channel+1} ${msgType}`, 'success');

    // Refresh mapping editor if open
    const editorModal = document.getElementById('mappingEditorModal');
    if (editorModal.classList.contains('active')) {
        openMappingEditor();
    }

    setTimeout(exitMidiLearn, 1000);
}

function showCurrentMidiMapping() {
    const container = document.getElementById('currentMidiMapping');
    if (!state.midiLearnTarget || !state.activeProfile) {
        container.innerHTML = 'No mapping assigned.';
        return;
    }

    const target = state.midiLearnTarget;
    const binding = getControlBinding(state.activeProfile, target.controlKey);
    container.innerHTML = `<div class="mapping-entry">
        <span class="entry-name">${target.label}</span>
        <span class="entry-midi">${binding}</span>
    </div>`;
}

// ============================================================
// MIDI LOG
// ============================================================
function addMidiLogMessage(type, channel, data1, data2) {
    const log = document.getElementById('midiLog');
    if (!log) return;

    const empty = log.querySelector('div[style*="color: #555"]');
    if (empty) log.innerHTML = '';

    const timestamp = new Date().toLocaleTimeString();
    let msg, cls;

    if (type === 0xB0) {
        msg = `[${timestamp}] Ch${channel + 1} CC ${data1}: ${data2}`;
        cls = 'midi-cc';
    } else if (type === 0x90 && data2 > 0) {
        msg = `[${timestamp}] Ch${channel + 1} Note On ${data1} (${data2})`;
        cls = 'midi-note-on';
    } else if (type === 0x80 || (type === 0x90 && data2 === 0)) {
        msg = `[${timestamp}] Ch${channel + 1} Note Off ${data1}`;
        cls = 'midi-note-off';
    } else if (type === 0xF8) {
        return;
    } else {
        msg = `[${timestamp}] 0x${type.toString(16)} Ch${channel + 1}: ${data1} ${data2}`;
        cls = '';
    }

    const line = document.createElement('div');
    line.className = cls;
    line.textContent = msg;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 100) log.removeChild(log.firstChild);
}

function addMidiLog(message, type = 'log') {
    const log = document.getElementById('midiLog');
    if (!log) return;
    const empty = log.querySelector('div[style*="color: #555"]');
    if (empty) log.innerHTML = '';
    const timestamp = new Date().toLocaleTimeString();
    const line = document.createElement('div');
    line.textContent = `[${timestamp}] ${message}`;
    const colors = { info: '#4a9eff', success: '#44dd44', warn: '#ffaa00', error: '#ff4444' };
    line.style.color = colors[type] || '#aaa';
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 100) log.removeChild(log.firstChild);
}

function clearMidiLog() {
    const log = document.getElementById('midiLog');
    if (log) log.innerHTML = '<div style="color: #555;">No MIDI messages</div>';
}

// ============================================================
// AUDIO OUTPUT
// ============================================================
async function populateAudioOutputs() {
    const select = document.getElementById('audioOutputSelect');
    if (!select) return;
    try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioOutputs = devices.filter(d => d.kind === 'audiooutput');
            audioOutputs.forEach(device => {
                const opt = document.createElement('option');
                opt.value = device.deviceId;
                opt.textContent = device.label || `Output ${device.deviceId.slice(0, 8)}`;
                select.appendChild(opt);
            });
            if (audioOutputs.length > 0) {
                select.addEventListener('change', async (e) => {
                    if (state.audioContext && state.audioContext.setSinkId) {
                        try {
                            await state.audioContext.setSinkId(e.target.value);
                            console.log('[Audio] Set output device');
                        } catch (err) {
                            console.warn('[Audio] Failed to set output:', err);
                        }
                    }
                });
            }
        }
    } catch (err) {
        console.warn('[Audio] Could not enumerate devices:', err);
    }
}

// ============================================================
// UI SETUP
// ============================================================
function updateStatus(deckIndex) {
    const deck = state.decks[deckIndex];
    const el = document.getElementById(`deckStatus-${deckIndex}`);
    if (!el) return;
    if (deck.playing) {
        el.innerHTML = `Deck ${deckIndex === 0 ? 'A' : 'B'}: <span>Playing</span>`;
    } else if (deck.track) {
        el.innerHTML = `Deck ${deckIndex === 0 ? 'A' : 'B'}: <span>Paused</span>`;
    } else {
        el.innerHTML = `Deck ${deckIndex === 0 ? 'A' : 'B'}: <span>Stopped</span>`;
    }
}

function setupFileInputs() {
    document.querySelectorAll('.load-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const deckIndex = parseInt(btn.dataset.deck);
            document.getElementById(`fileInput-${deckIndex}`).click();
        });
    });
    for (let d = 0; d < 2; d++) {
        document.getElementById(`fileInput-${d}`).addEventListener('change', (e) => {
            if (e.target.files.length > 0) {
                loadTrackToDeck(d, e.target.files[0]);
            }
        });
    }
}

function setupEQControls() {
    // Listen for cc-change events from pad-knob elements
    document.addEventListener('cc-change', (e) => {
        const knob = e.target;
        const knobId = knob.id || '';
        const detail = e.detail;
        if (!detail) return;

        // Parse deck index and band from knob ID: eqKnob-{band}-{deck}
        const match = knobId.match(/^eqKnob-(\w+)-(\d)$/);
        if (!match) return;

        const band = match[1].toLowerCase();
        const deckIndex = parseInt(match[2]);

        if (band === 'filter') {
            setFilter(deckIndex, detail.value);
        } else {
            setEQ(deckIndex, band, detail.value);
        }
    });

    // Setup fader and crossfader drag interactions
    setupFaderDrag();
}

function setupFaderDrag() {
    // Vertical faders (Vol A / Vol B)
    document.querySelectorAll('[data-fader]').forEach(track => {
        const deckIndex = parseInt(track.dataset.fader);
        let dragging = false;

        function valueFromY(clientY) {
            const rect = track.getBoundingClientRect();
            const y = clientY - rect.top;
            const pct = 1 - Math.max(0, Math.min(1, y / rect.height));
            return Math.round(pct * 127);
        }

        function updateFromEvent(e) {
            const clientY = e.touches ? e.touches[0].clientY : e.clientY;
            setFader(deckIndex, valueFromY(clientY));
        }

        function onStart(e) {
            dragging = true;
            updateFromEvent(e);
            e.preventDefault();
        }
        function onMove(e) {
            if (!dragging) return;
            updateFromEvent(e);
            e.preventDefault();
        }
        function onEnd() {
            dragging = false;
        }

        track.addEventListener('mousedown', onStart);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onEnd);
        track.addEventListener('touchstart', onStart, { passive: false });
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onEnd);
    });

    // Crossfader (horizontal)
    const xfade = document.getElementById('crossfaderTrack');
    if (xfade) {
        let dragging = false;

        function xfadeValueFromX(clientX) {
            const rect = xfade.getBoundingClientRect();
            const x = clientX - rect.left;
            const pct = Math.max(0, Math.min(1, x / rect.width));
            return Math.round(pct * 127);
        }

        function updateXfade(e) {
            const clientX = e.touches ? e.touches[0].clientX : e.clientX;
            setCrossfader(xfadeValueFromX(clientX));
        }

        function onXStart(e) {
            dragging = true;
            updateXfade(e);
            e.preventDefault();
        }
        function onXMove(e) {
            if (!dragging) return;
            updateXfade(e);
            e.preventDefault();
        }
        function onXEnd() { dragging = false; }

        xfade.addEventListener('mousedown', onXStart);
        document.addEventListener('mousemove', onXMove);
        document.addEventListener('mouseup', onXEnd);
        xfade.addEventListener('touchstart', onXStart, { passive: false });
        document.addEventListener('touchmove', onXMove, { passive: false });
        document.addEventListener('touchend', onXEnd);
    }
}

function setupTransportButtons() {
    for (let d = 0; d < 2; d++) {
        document.getElementById(`play-${d}`).addEventListener('click', () => togglePlay(d));
        document.getElementById(`cue-${d}`).addEventListener('click', () => toggleCue(d));
        document.getElementById(`sync-${d}`).addEventListener('click', () => toggleSync(d));
        document.getElementById(`prev-${d}`).addEventListener('click', () => trackerPrevPattern(d));
        document.getElementById(`next-${d}`).addEventListener('click', () => trackerNextPattern(d));
        document.getElementById(`loop-${d}`).addEventListener('click', () => toggleLoop(d));
    }
}

function setupMIDIControls() {
    document.getElementById('midiConnectBtn').addEventListener('click', connectMIDI);
    document.getElementById('midiLearnBtn').addEventListener('click', openMappingEditor);
    document.getElementById('clearMidiLog').addEventListener('click', clearMidiLog);

    // Profile selector
    const profileSelect = document.getElementById('controllerProfileSelect');
    if (profileSelect) {
        profileSelect.addEventListener('change', async (e) => {
            const profile = state.profiles.find(p => p.name === e.target.value);
            if (profile) {
                await activateProfile(profile);
                addMidiLog(`Switched to controller profile: ${profile.name}`, 'info');
            }
        });
    }

    // MIDI Learn Modal
    document.getElementById('midiLearnClose').addEventListener('click', () => {
        document.getElementById('midiLearnOverlay').classList.remove('active');
        document.getElementById('midiLearnModal').classList.remove('active');
        exitMidiLearn();
    });
    document.getElementById('midiLearnOverlay').addEventListener('click', () => {
        document.getElementById('midiLearnOverlay').classList.remove('active');
        document.getElementById('midiLearnModal').classList.remove('active');
        exitMidiLearn();
    });
    document.getElementById('midiLearnClearBtn').addEventListener('click', () => {
        if (state.midiLearnTarget && state.activeProfile) {
            clearControlOverride(state.midiLearnTarget.controlKey);
            showCurrentMidiMapping();
            document.getElementById('midiLearnStatus').textContent = '✅ Mapping cleared';
            addMidiLog(`Cleared mapping for "${state.midiLearnTarget.label}"`, 'info');
        }
    });
}

// ============================================================
// MAPPING EDITOR
// ============================================================
function openMappingEditor() {
    if (!state.activeProfile) return;

    const modal = document.getElementById('mappingEditorModal');
    const overlay = document.getElementById('mappingEditorOverlay');
    const body = document.getElementById('mappingEditorBody');

    const controls = getProfileControls(state.activeProfile);

    let html = `<p style="margin-bottom: 15px;">
        Profile: <strong>${state.activeProfile.name}</strong>
        &mdash; Click "Learn" next to a control, then move the corresponding knob/fader on your MIDI device.
    </p>`;

    html += '<table class="mapping-table">';
    html += '<tr><th>Control</th><th>MIDI Binding</th><th></th></tr>';

    controls.forEach(ctrl => {
        const binding = getControlBinding(state.activeProfile, ctrl.controlKey);
        const hasOverride = state.profileOverrides[state.activeProfile.name]?.[ctrl.controlKey];

        const bindDisplay = binding !== 'Not mapped'
            ? binding
            : '<span class="unmapped">Not mapped</span>';

        html += `<tr>
            <td class="ctrl-name">${ctrl.deckLabel}: ${ctrl.label}</td>
            <td class="midi-msg">${bindDisplay}</td>
            <td style="text-align: right; white-space: nowrap;">
                <button class="midi-learn-btn"
                    data-control-key="${ctrl.controlKey}"
                    data-label="${ctrl.deckLabel}: ${ctrl.label}"
                    data-target="${ctrl.id}"
                    data-deck="${ctrl.deckId}"
                    style="padding: 4px 10px; font-size: 0.75em; ${hasOverride ? 'background: #1a3311; border-color: #33aa33;' : ''}">
                    ${hasOverride ? 'Re-learn' : 'Learn'}
                </button>
                ${hasOverride ? `<button class="midi-clear-btn" data-control-key="${ctrl.controlKey}"
                    style="padding: 4px 8px; font-size: 0.7em; background: #331111; border-color: #882222;">✕</button>` : ''}
            </td>
        </tr>`;
    });

    html += '</table>';

    // Deck type and per-deck MIDI channel configuration
    html += `<div style="margin-top: 20px; padding-top: 15px; border-top: 1px solid var(--border);">
        <h4 style="color: var(--accent); margin-bottom: 10px; text-transform: uppercase; letter-spacing: 1px; font-size: 0.85em;">Deck Configuration</h4>
        <table class="mapping-table">
            <tr><th>Deck</th><th>Type</th><th>MIDI Channel</th></tr>`;

    // Deck configuration from sections with deck assignments
    const deckSections = state.activeProfile.sections
        ? state.activeProfile.sections.filter(s => s.deck !== undefined)
        : [];
    const seenDecks = new Set();
    for (const section of deckSections) {
        if (seenDecks.has(section.deck)) continue;
        seenDecks.add(section.deck);
        const deckType = (state.activeProfile.deckConfig && state.activeProfile.deckConfig.type) || 'audio';
        const ch = section.midiChannel !== undefined
            ? section.midiChannel
            : ((state.activeProfile.deckConfig && state.activeProfile.deckConfig.midiBaseChannel) || 0) + section.deck;
        html += `<tr>
            <td class="ctrl-name">${section.title || `Deck ${String.fromCharCode(65 + section.deck)}`}</td>
            <td>${deckType}</td>
            <td style="font-family: monospace;">Ch ${ch + 1}</td>
        </tr>`;
    }
    html += '</table></div>';

    html += '<div style="margin-top: 15px; display: flex; gap: 10px;">';
    html += '<button id="resetMappingsBtn" style="background: #331100; border-color: #884400;">Reset to Defaults</button>';
    html += '</div>';

    body.innerHTML = html;

    // Attach learn button handlers
    body.querySelectorAll('.midi-learn-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = {
                controlKey: btn.dataset.controlKey,
                target: btn.dataset.target,
                deck: parseInt(btn.dataset.deck),
                label: btn.dataset.label
            };
            enterMidiLearn(target);
            document.getElementById('midiLearnStatus').textContent = `🎯 Learning: ${target.label}...`;
            document.getElementById('midiLearnTarget').textContent = target.label;
            showCurrentMidiMapping();
            document.getElementById('midiLearnOverlay').classList.add('active');
            document.getElementById('midiLearnModal').classList.add('active');
        });
    });

    body.querySelectorAll('.midi-clear-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            clearControlOverride(btn.dataset.controlKey);
            addMidiLog(`Cleared mapping for control key: ${btn.dataset.controlKey}`, 'info');
            openMappingEditor();
        });
    });

    const resetBtn = document.getElementById('resetMappingsBtn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetProfileOverrides();
            addMidiLog('Controller mappings reset to defaults', 'info');
            openMappingEditor();
        });
    }

    overlay.classList.add('active');
    modal.classList.add('active');
}

document.getElementById('mappingEditorClose').addEventListener('click', () => {
    document.getElementById('mappingEditorOverlay').classList.remove('active');
    document.getElementById('mappingEditorModal').classList.remove('active');
});
document.getElementById('mappingEditorOverlay').addEventListener('click', () => {
    document.getElementById('mappingEditorOverlay').classList.remove('active');
    document.getElementById('mappingEditorModal').classList.remove('active');
});

// ============================================================
// MENU / MODAL
// ============================================================
function setupMenu() {
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    const menuOverlay = document.getElementById('menuOverlay');
    const menuPanel = document.getElementById('menuPanel');
    const menuClose = document.getElementById('menuClose');

    function toggleMenu() {
        menuOverlay.classList.toggle('active');
        menuPanel.classList.toggle('active');
    }
    function closeMenu() {
        menuOverlay.classList.remove('active');
        menuPanel.classList.remove('active');
    }

    hamburgerBtn.addEventListener('click', toggleMenu);
    menuClose.addEventListener('click', closeMenu);
    menuOverlay.addEventListener('click', closeMenu);

    document.getElementById('showCreditsBtn').addEventListener('click', () => {
        document.getElementById('creditsOverlay').classList.add('active');
        document.getElementById('creditsModal').classList.add('active');
        closeMenu();
    });
    document.getElementById('creditsClose').addEventListener('click', () => {
        document.getElementById('creditsOverlay').classList.remove('active');
        document.getElementById('creditsModal').classList.remove('active');
    });
    document.getElementById('creditsOverlay').addEventListener('click', () => {
        document.getElementById('creditsOverlay').classList.remove('active');
        document.getElementById('creditsModal').classList.remove('active');
    });
}

// ============================================================
// INIT
// ============================================================
window.addEventListener('load', async () => {
    console.log('[KaoticDJ] Starting...');

    // Load controller profiles first
    await loadProfiles();

    initAudio();
    initBPMWorker();
    setupFileInputs();
    setupEQControls();
    setupTransportButtons();
    setupMIDIControls();
    setupMenu();

    // Initialize fader and crossfader visual positions
    for (let d = 0; d < 2; d++) {
        setFader(d, state.decks[d].volume);
    }
    setCrossfader(state.crossfader);

    for (let d = 0; d < 2; d++) {
        setupJogWheel(d);
    }

    initMIDI();

    if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen').catch(() => {});
    }

    console.log('[KaoticDJ] Ready');
});
