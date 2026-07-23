/**
 * BPM Detection Web Worker
 * Runs beat analysis in the background without blocking the UI
 */

self.onmessage = function(e) {
    const { audioData, sampleRate, deckIndex } = e.data;
    const result = detectBPM(audioData, sampleRate);

    self.postMessage({
        deckIndex: deckIndex,
        bpm: result.bpm,
        confidence: result.confidence,
        beats: result.beats
    });
};

function detectBPM(data, sampleRate) {
    const frameSize = 2048;
    const hopSize = 512;
    const numFrames = Math.floor(data.length / hopSize);

    // 1. Compute energy envelope
    let energies = new Float32Array(numFrames);
    for (let i = 0; i < numFrames - 1; i++) {
        let energy = 0;
        for (let j = 0; j < frameSize && (i * hopSize + j) < data.length; j++) {
            energy += data[i * hopSize + j] * data[i * hopSize + j];
        }
        energy /= frameSize;
        energies[i] = energy;
    }

    // 2. Find energy peaks (onsets)
    let peaks = [];
    let threshold = 0;
    for (let i = 0; i < energies.length; i++) {
        threshold += energies[i];
    }
    threshold /= energies.length;

    for (let i = 2; i < energies.length - 2; i++) {
        if (energies[i] > threshold &&
            energies[i] > energies[i-1] &&
            energies[i] > energies[i-2] &&
            energies[i] > energies[i+1] &&
            energies[i] > energies[i+2]) {
            peaks.push(i);
        }
    }

    // 3. Calculate inter-beat intervals
    if (peaks.length < 4) {
        return { bpm: null, confidence: 0, beats: [] };
    }

    let intervals = [];
    for (let i = 1; i < peaks.length; i++) {
        intervals.push((peaks[i] - peaks[i-1]) * hopSize / sampleRate);
    }

    // 4. Cluster intervals to find the dominant BPM
    intervals.sort((a, b) => a - b);
    let clusters = [];
    let currentCluster = [intervals[0]];

    for (let i = 1; i < intervals.length; i++) {
        if (Math.abs(intervals[i] - currentCluster[0]) / currentCluster[0] < 0.15) {
            currentCluster.push(intervals[i]);
        } else {
            clusters.push(currentCluster);
            currentCluster = [intervals[i]];
        }
    }
    clusters.push(currentCluster);

    // Find largest cluster
    let bestCluster = clusters.reduce((a, b) => a.length > b.length ? a : b);
    let avgInterval = bestCluster.reduce((a, b) => a + b, 0) / bestCluster.length;
    let rawBpm = 60 / avgInterval;

    // 5. Clamp to reasonable range
    let bpm = null;
    if (rawBpm >= 60 && rawBpm <= 200) {
        bpm = Math.round(rawBpm);
    } else if (rawBpm > 200) {
        // Could be double-time, halve it
        bpm = Math.round(rawBpm / 2);
        if (bpm < 60 || bpm > 200) bpm = Math.round(rawBpm / 3);
    } else if (rawBpm < 60) {
        // Could be half-time, double it
        bpm = Math.round(rawBpm * 2);
        if (bpm < 60 || bpm > 200) bpm = Math.round(rawBpm * 3);
    }

    if (bpm < 60 || bpm > 200) {
        bpm = null;
    }

    const confidence = bestCluster.length / intervals.length;

    return { bpm, confidence, beats: peaks.map(p => p * hopSize / sampleRate) };
}
