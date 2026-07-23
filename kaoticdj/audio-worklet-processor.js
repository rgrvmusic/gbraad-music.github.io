// AudioWorklet Processor for WASM effects
// With MINIFY_WASM_IMPORTED_MODULES=0, function names are preserved!

class WasmEffectsProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        this.wasmModule = null;
        this.effects = new Map();
        this.specialFilters = new Map(); // MS-20 and 700S loaded separately
        this.audioBufferPtr = null;
        this.bufferSize = 8192;
        this.lastFrame = [0, 0]; // Store last frame to prevent clicks
        this.dcBlockerX = [0, 0]; // Previous input for DC blocker
        this.dcBlockerY = [0, 0]; // Previous output for DC blocker
        this.peakLevelFrameCounter = 0; // Counter for peak level polling
        this.processCallCount = 0; // Debug: count process() calls

        this.port.onmessage = this.handleMessage.bind(this);

        // Get WASM bytes from the main thread
        this.port.postMessage({ type: 'needWasm' });
    }

    handleMessage(event) {
        const { type, data, state } = event.data;

        if (type === 'wasmBytes') {
            this.initWasm(data);  // Just the bytes, not JS code
        } else if (type === 'specialFilterBytes') {
            this.initSpecialFilter(data);  // MS-20 or 700S filter module
        } else if (type === 'toggle') {
            this.toggleEffect(data.name, data.enabled);
        } else if (type === 'setParam') {
            this.setParameter(data.effect, data.param, data.value);
        } else if (type === 'getState') {
            const currentState = this.getEffectState();
            this.port.postMessage({ type: 'state', state: currentState });
        } else if (type === 'setState') {
            this.setEffectState(state);
        }
    }

    async initWasm(wasmData) {
        try {
            console.log('[Worklet] Loading Emscripten module...');
            console.log('[Worklet] WASM size:', (wasmData.wasmBytes.byteLength / 1024).toFixed(1), 'KB');

            const moduleCode = wasmData.jsCode;
            const wasmBytes = wasmData.wasmBytes;

            // Eval the Emscripten loader and capture memory reference
            // Modify code to expose wasmMemory before it returns
            const modifiedCode = moduleCode.replace(
                ';return moduleRtn',
                ';globalThis.__wasmMemory=wasmMemory;return moduleRtn'
            );

            eval(modifiedCode + '\nthis.RegrooveEffectsModule = RegrooveEffectsModule;');

            // Call the factory with WASM bytes
            this.wasmModule = await this.RegrooveEffectsModule({
                wasmBinary: wasmBytes
            });

            // Capture the memory reference that was exposed
            this.wasmMemory = globalThis.__wasmMemory;
            delete globalThis.__wasmMemory; // Clean up

            console.log('[Worklet] WASM ready!');

            // Allocate audio buffer
            this.audioBufferPtr = this.wasmModule._malloc(this.bufferSize * 2 * 4);
            console.log(`[Worklet] Buffer: 0x${this.audioBufferPtr.toString(16)}`);

            // Initialize all effects
            this.initEffects();

            this.port.postMessage({ type: 'ready' });
            console.log('[Worklet] ✅ Ready!');
        } catch (error) {
            console.error('[Worklet] ❌ Failed:', error);
            this.port.postMessage({ type: 'error', error: error.message });
        }
    }

    async initSpecialFilter(wasmData) {
        try {
            const { name, jsCode, wasmBytes } = wasmData;
            console.log(`[Worklet] Loading special filter: ${name}...`);

            // Eval the Emscripten loader
            const modifiedCode = jsCode.replace(
                ';return moduleRtn',
                ';globalThis.__wasmMemory_' + name + '=wasmMemory;return moduleRtn'
            );

            eval(modifiedCode + '\nglobalThis.__filterModule_' + name + ' = ' + wasmData.moduleName + ';');

            // Call the factory with WASM bytes
            const moduleFactory = globalThis['__filterModule_' + name];
            delete globalThis['__filterModule_' + name];

            const module = await moduleFactory({
                wasmBinary: wasmBytes
            });

            // Create filter instance based on type
            let filterPtr, filterConfig;
            if (name === 'ms20_hp_filter') {
                filterPtr = module._ms20_create();
                module._ms20_set_sample_rate(filterPtr, globalThis.sampleRate || 48000);
                // Set safe defaults (wide open HP filter)
                module._ms20_set_mode(filterPtr, 1); // HP mode (MS-20 HP Filter)
                module._ms20_set_cutoff(filterPtr, 20.0); // Low cutoff (pass everything for HPF)
                module._ms20_set_resonance(filterPtr, 0.5); // Minimal resonance
                module._ms20_set_drive(filterPtr, 1.0); // Unity drive
                filterConfig = {
                    ptr: filterPtr,
                    module: module,
                    name: 'ms20_hp_filter',
                    prefix: '_ms20',
                    enabled: false,
                    memory: globalThis['__wasmMemory_' + name]
                };
            } else if (name === 'ms20_lp_filter') {
                filterPtr = module._ms20_create();
                module._ms20_set_sample_rate(filterPtr, globalThis.sampleRate || 48000);
                // Set safe defaults (wide open LP filter)
                module._ms20_set_mode(filterPtr, 0); // LP mode (MS-20 LP Filter)
                module._ms20_set_cutoff(filterPtr, 20000.0); // High cutoff (pass everything for LPF)
                module._ms20_set_resonance(filterPtr, 0.5); // Minimal resonance
                module._ms20_set_drive(filterPtr, 1.0); // Unity drive
                filterConfig = {
                    ptr: filterPtr,
                    module: module,
                    name: 'ms20_lp_filter',
                    prefix: '_ms20',
                    enabled: false,
                    memory: globalThis['__wasmMemory_' + name]
                };
            } else if (name === '700s_filter') {
                filterPtr = module._filter700s_create();
                module._filter700s_set_sample_rate(filterPtr, globalThis.sampleRate || 48000);
                // Set safe defaults (wide open filter)
                module._filter700s_set_hp_cutoff(filterPtr, 20.0); // Low HP cutoff (pass everything)
                module._filter700s_set_lp_cutoff(filterPtr, 20000.0); // High LP cutoff (pass everything)
                module._filter700s_set_resonance(filterPtr, 0.5); // Minimal resonance
                module._filter700s_set_brightness(filterPtr, 0.5); // Mid brightness
                filterConfig = {
                    ptr: filterPtr,
                    module: module,
                    name: '700s_filter',
                    prefix: '_filter700s',
                    enabled: false,
                    memory: globalThis['__wasmMemory_' + name]
                };
            }

            this.specialFilters.set(name, filterConfig);
            delete globalThis['__wasmMemory_' + name];

            console.log(`[Worklet] ${name}: 0x${filterPtr.toString(16)} (disabled)`);
            this.port.postMessage({ type: 'specialFilterReady', name: name });
        } catch (error) {
            console.error(`[Worklet] Special filter ${wasmData.name} failed:`, error);
            this.port.postMessage({ type: 'error', error: error.message });
        }
    }

    initEffects() {
        // Processing order: TRIM → SCULPT → LPF → HPF → other effects
        const effectConfigs = [
            { name: 'model1_trim', prefix: '_fx_model1_trim', defaultEnabled: true },
            { name: 'model1_sculpt', prefix: '_fx_model1_sculpt', defaultEnabled: true },
            { name: 'model1_lpf', prefix: '_fx_model1_lpf', defaultEnabled: true },
            { name: 'model1_hpf', prefix: '_fx_model1_hpf', defaultEnabled: true },
            { name: 'distortion', prefix: '_fx_distortion', defaultEnabled: false },
            { name: 'limiter', prefix: '_fx_limiter', defaultEnabled: false },
            { name: 'filter', prefix: '_fx_filter', defaultEnabled: false },
            { name: 'eq', prefix: '_fx_eq', defaultEnabled: false },
            { name: 'compressor', prefix: '_fx_compressor', defaultEnabled: false },
            { name: 'delay', prefix: '_fx_delay', defaultEnabled: false },
            { name: 'reverb', prefix: '_fx_reverb', defaultEnabled: false },
            { name: 'phaser', prefix: '_fx_phaser', defaultEnabled: false },
            { name: 'stereo_widen', prefix: '_fx_stereo_widen', defaultEnabled: false },
            { name: 'ring_mod', prefix: '_fx_ring_mod', defaultEnabled: false },
            { name: 'pitchshift', prefix: '_fx_pitchshift', defaultEnabled: false },
            { name: 'lofi', prefix: '_fx_lofi', defaultEnabled: false }
        ];

        for (const config of effectConfigs) {
            const createFn = this.wasmModule[config.prefix + '_create'];
            if (createFn) {
                // Lofi needs sample rate parameter
                const ptr = (config.name === 'lofi')
                    ? createFn(globalThis.sampleRate || 48000)
                    : createFn();

                this.effects.set(config.name, {
                    ptr: ptr,
                    name: config.name,
                    prefix: config.prefix,
                    enabled: config.defaultEnabled
                });

                // Actually enable MODEL 1 effects in WASM
                if (config.defaultEnabled) {
                    const setEnabledFn = this.wasmModule[config.prefix + '_set_enabled'];
                    if (setEnabledFn) {
                        setEnabledFn(ptr, 1);
                    }
                }

                console.log(`[Worklet] ${config.name}: 0x${ptr.toString(16)} (${config.defaultEnabled ? 'enabled' : 'disabled'})`);
            } else {
                console.error(`[Worklet] ${config.name}: CREATE FUNCTION NOT FOUND! (${config.prefix}_create)`);
            }
        }
    }

    toggleEffect(name, enabled) {
        // Check both regular effects and special filters
        let effect = this.effects.get(name);
        let isSpecial = false;
        let module = this.wasmModule;

        if (!effect) {
            effect = this.specialFilters.get(name);
            if (effect) {
                isSpecial = true;
                module = effect.module;
            }
        }

        if (!effect || !module) {
            console.error(`[Worklet] Effect not found: ${name}`);
            return;
        }

        // Reset filter state BEFORE changing enabled state to clear any artifacts
        const resetFn = module[effect.prefix + '_reset'];
        if (resetFn) {
            resetFn(effect.ptr);
        }

        // Set enabled/disabled state
        effect.enabled = enabled;

        // IMPORTANT: Call the WASM set_enabled function for regular effects
        if (!isSpecial) {
            const setEnabledFn = module[effect.prefix + '_set_enabled'];
            if (setEnabledFn) {
                setEnabledFn(effect.ptr, enabled ? 1 : 0);
                console.log(`[Worklet] ${name} ${enabled ? 'ENABLED' : 'DISABLED'} (called WASM function)`);
            } else {
                console.warn(`[Worklet] ${name} set_enabled function not found: ${effect.prefix}_set_enabled`);
            }
        } else {
            console.log(`[Worklet] ${name} ${enabled ? 'ENABLED' : 'DISABLED'} (special filter)`);
        }

        // Reset DC blocker state when toggling to prevent clicks
        this.dcBlockerX = [0, 0];
        this.dcBlockerY = [0, 0];
    }

    setParameter(effectName, paramName, value) {
        // Check both regular effects and special filters
        let effect = this.effects.get(effectName);
        let module = this.wasmModule;
        let isSpecial = false;

        if (!effect) {
            effect = this.specialFilters.get(effectName);
            if (effect) {
                module = effect.module;
                isSpecial = true;
            }
        }

        if (!effect || !module) return;

        // Map UI values (0-1) to actual parameter ranges for special filters
        let mappedValue = value;
        if (isSpecial) {
            if (effectName === 'ms20_hp_filter' || effectName === 'ms20_lp_filter') {
                if (paramName === 'cutoff') {
                    // Cutoff: 20 Hz - 20 kHz (logarithmic)
                    mappedValue = 20.0 * Math.pow(1000.0, value);
                } else if (paramName === 'resonance') {
                    // Resonance: 0% = 0.5, 50% = 5.0, 100% = 10.0
                    mappedValue = Math.max(0.5, value * 10.0);
                } else if (paramName === 'drive') {
                    // Drive: 0.1 - 10.0 (LINEAR)
                    mappedValue = 0.1 + value * 9.9;
                }
            } else if (effectName === '700s_filter') {
                if (paramName === 'hp_cutoff' || paramName === 'lp_cutoff') {
                    // Cutoff: 20 Hz - 20 kHz (logarithmic)
                    mappedValue = 20.0 * Math.pow(1000.0, value);
                } else if (paramName === 'resonance') {
                    // Resonance: 0.5 - 15.0 (logarithmic)
                    mappedValue = 0.5 + (value * value) * 14.5;
                } else if (paramName === 'brightness') {
                    // Brightness: 0.0 - 1.0 (linear)
                    mappedValue = value;
                }
            }
        }

        // Use direct function name: _prefix_set_parametername
        const funcName = effect.prefix + '_set_' + paramName;
        const setFn = module[funcName];
        if (setFn) {
            setFn(effect.ptr, mappedValue);
            if (isSpecial) {
                console.log(`[Worklet] ${funcName}(${effect.ptr}, ${mappedValue.toFixed(2)}) [UI: ${value.toFixed(3)}]`);
            }
        } else {
            console.error(`[Worklet] ${funcName} NOT FOUND!`);
        }
    }

    getEffectState() {
        const state = { effects: {} };

        // Parameter map for each effect
        const effectParams = {
            'model1_trim': ['drive'],
            'model1_hpf': ['cutoff'],
            'model1_lpf': ['cutoff'],
            'model1_sculpt': ['frequency', 'gain'],
            'distortion': ['drive', 'mix'],
            'limiter': ['threshold', 'release', 'ceiling', 'lookahead'],
            'filter': ['cutoff', 'resonance'],
            'eq': ['low', 'mid', 'high'],
            'compressor': ['threshold', 'ratio', 'attack', 'release', 'makeup'],
            'delay': ['time', 'feedback', 'mix'],
            'reverb': ['size', 'damping', 'mix'],
            'phaser': ['rate', 'depth', 'feedback'],
            'stereo_widen': ['width', 'mix'],
            'ring_mod': ['frequency', 'mix'],
            'pitchshift': ['pitch', 'mix'],
            'lofi': ['bit_depth', 'sample_rate_ratio', 'filter_cutoff', 'saturation', 'noise_level', 'wow_flutter_depth', 'wow_flutter_rate'],
            'ms20_hp_filter': ['cutoff', 'resonance', 'drive'],
            'ms20_lp_filter': ['cutoff', 'resonance', 'drive'],
            '700s_filter': ['hp_cutoff', 'lp_cutoff', 'resonance', 'brightness']
        };

        // Get state from regular effects
        for (const [name, effect] of this.effects) {
            const params = {};

            // Get enabled state
            const getEnabledFn = this.wasmModule[effect.prefix + '_get_enabled'];
            if (getEnabledFn) {
                params.enabled = getEnabledFn(effect.ptr);
            }

            // Get all parameters for this effect
            const paramNames = effectParams[name] || [];
            for (const paramName of paramNames) {
                const getFn = this.wasmModule[effect.prefix + '_get_' + paramName];
                if (getFn) {
                    params[paramName] = getFn(effect.ptr);
                }
            }

            state.effects[name] = params;
        }

        // Get state from special filters
        for (const [name, effect] of this.specialFilters) {
            const params = {};
            params.enabled = effect.enabled ? 1 : 0;

            // Get all parameters for this filter
            const paramNames = effectParams[name] || [];
            for (const paramName of paramNames) {
                const getFn = effect.module[effect.prefix + '_get_' + paramName];
                if (getFn) {
                    params[paramName] = getFn(effect.ptr);
                }
            }

            state.effects[name] = params;
        }

        return state;
    }

    setEffectState(state) {
        if (!state || !state.effects) {
            console.log('[Worklet] setState: no state');
            return;
        }

        console.log('[Worklet] Setting state for', Object.keys(state.effects).length, 'effects');

        for (const [name, params] of Object.entries(state.effects)) {
            let effect = this.effects.get(name);
            let isSpecial = false;

            if (!effect) {
                effect = this.specialFilters.get(name);
                if (effect) {
                    isSpecial = true;
                }
            }

            if (!effect) {
                console.log('[Worklet] Effect not found:', name);
                continue;
            }

            // Set enabled state
            if (params.enabled !== undefined) {
                if (isSpecial) {
                    effect.enabled = params.enabled !== 0;
                    console.log('[Worklet]', name, 'enabled:', params.enabled, '(special)');
                } else {
                    const setEnabledFn = this.wasmModule[effect.prefix + '_set_enabled'];
                    if (setEnabledFn) {
                        setEnabledFn(effect.ptr, params.enabled);
                        effect.enabled = params.enabled !== 0;
                        console.log('[Worklet]', name, 'enabled:', params.enabled);
                    }
                }
            }

            // Set other parameters
            for (const [paramName, value] of Object.entries(params)) {
                if (paramName !== 'enabled') {
                    this.setParameter(name, paramName, value);
                    console.log('[Worklet]', name, paramName, '=', value);
                }
            }
        }

        console.log('[Worklet] ✅ State applied');
        this.port.postMessage({ type: 'stateApplied' });
    }

    process(inputs, outputs, parameters) {
        if (!this.wasmModule || !this.audioBufferPtr) {
            return true;
        }

        const input = inputs[0];
        const output = outputs[0];

        if (!input || !output || input.length === 0) {
            return true;
        }

        // Debug: Log first few process() calls
        this.processCallCount++;
        if (this.processCallCount <= 3) {
            console.log(`[Worklet] process() called #${this.processCallCount}, frames:`, input[0].length);
        }

        const frames = input[0].length;
        const inputL = input[0];
        const inputR = input[1] || input[0];

        // Check if any effects are actually enabled
        let hasEnabledEffects = false;
        for (const [name, effect] of this.effects) {
            if (effect.enabled) {
                hasEnabledEffects = true;
                break;
            }
        }
        for (const [name, filter] of this.specialFilters) {
            if (filter.enabled) {
                hasEnabledEffects = true;
                break;
            }
        }

        // If no effects enabled, pass through directly (bypass WASM)
        if (!hasEnabledEffects) {
            const outputL = output[0];
            const outputR = output[1] || output[0];
            for (let i = 0; i < frames; i++) {
                outputL[i] = inputL[i];
                outputR[i] = inputR[i];
            }
            return true;
        }

        // Update heap view - access memory through captured wasmMemory
        const heapF32 = new Float32Array(
            this.wasmMemory.buffer,
            this.audioBufferPtr,
            frames * 2
        );

        // Interleave input
        for (let i = 0; i < frames; i++) {
            heapF32[i * 2] = inputL[i];
            heapF32[i * 2 + 1] = inputR[i];
        }

        // Process through enabled effects
        const sr = globalThis.sampleRate || 48000; // AudioWorkletGlobalScope.sampleRate
        for (const [name, effect] of this.effects) {
            if (effect.enabled) {
                // Determine process function based on effect type
                // model1_ and stereo_widen use interleaved processing
                const processSuffix = (name.startsWith('model1_') || name === 'stereo_widen')
                    ? '_process_interleaved'
                    : '_process_f32';
                const processFn = this.wasmModule[effect.prefix + processSuffix];

                if (processFn) {
                    processFn(effect.ptr, this.audioBufferPtr, frames, sr);
                }
            }
        }

        // Process through enabled special filters
        for (const [name, filter] of this.specialFilters) {
            if (filter.enabled) {
                // Special filters use stereo processing with separate L/R buffers
                if (!filter.leftBufferPtr) {
                    filter.leftBufferPtr = filter.module._malloc(this.bufferSize * 4);
                    filter.rightBufferPtr = filter.module._malloc(this.bufferSize * 4);
                    console.log(`[Worklet] ${name} allocated buffers: L=0x${filter.leftBufferPtr.toString(16)} R=0x${filter.rightBufferPtr.toString(16)}`);
                }

                // IMPORTANT: Recreate views each time to handle potential memory growth
                const filterMemory = filter.module.memory || filter.memory;
                const leftHeap = new Float32Array(filterMemory.buffer, filter.leftBufferPtr, frames);
                const rightHeap = new Float32Array(filterMemory.buffer, filter.rightBufferPtr, frames);

                // De-interleave to separate buffers
                for (let i = 0; i < frames; i++) {
                    leftHeap[i] = heapF32[i * 2];
                    rightHeap[i] = heapF32[i * 2 + 1];
                }

                // Process stereo
                const processFn = filter.module[filter.prefix + '_process_stereo'];
                if (processFn) {
                    console.log(`[Worklet] ${name} processing ${frames} frames via ${filter.prefix}_process_stereo`);
                    processFn(filter.ptr, filter.leftBufferPtr, filter.rightBufferPtr,
                             filter.leftBufferPtr, filter.rightBufferPtr, frames);

                    // Re-interleave back
                    for (let i = 0; i < frames; i++) {
                        heapF32[i * 2] = leftHeap[i];
                        heapF32[i * 2 + 1] = rightHeap[i];
                    }
                } else {
                    console.error(`[Worklet] ${name} process function NOT FOUND: ${filter.prefix}_process_stereo`);
                }
            }
        }

        // De-interleave output
        const outputL = output[0];
        const outputR = output[1] || output[0];

        // Simple de-interleave - WASM effects handle clipping internally
        for (let i = 0; i < frames; i++) {
            outputL[i] = heapF32[i * 2];
            outputR[i] = heapF32[i * 2 + 1];
        }

        return true;
    }
}

registerProcessor('wasm-effects-processor', WasmEffectsProcessor);
