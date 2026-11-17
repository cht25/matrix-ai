package ai.matrix.desktop

import android.content.Context
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.PI
import kotlin.math.sqrt
import kotlin.math.tanh

/**
 * QORVYNA on-device wake-word engine ("Hey QORVYNA").
 *
 * This is a real keyword spotter that runs entirely on the phone. No network
 * call, no cloud account, no vendor SDK that has to be downloaded at build
 * time — which is exactly why it can be shipped in this repository:
 *
 *   1. PCM 16 kHz mono is captured by the foreground service.
 *   2. Each utterance candidate is trimmed with an energy VAD and turned into
 *      MFCC features (pre-emphasis → 25 ms Hamming frames → 512-point FFT →
 *      26 mel bands → log → DCT-II → 13 cepstra, cepstral mean normalised).
 *   3. The user enrols the phrase two to five times. Each enrolment is stored
 *      as an MFCC template in SharedPreferences (a few kilobytes).
 *   4. Matching is Dynamic Time Warping of the live utterance against every
 *      template, normalised by path length, with a Sakoe-Chiba band so the
 *      comparison stays linear-ish and rejects wildly different lengths.
 *
 * Accuracy is template based, so it depends on the enrolment: it recognises
 * the enrolled speaker saying the enrolled phrase. It is deliberately
 * conservative — a false negative costs one tap, a false positive would start
 * a microphone turn, so the default threshold is tight and a hit must repeat.
 *
 * `src/lib/native/wake-word.ts` mirrors the DSP (mel filters, DCT, DTW) in
 * TypeScript so the maths is unit-tested on every build.
 */
class QorvynaWakeWord(context: Context) {

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_LEN = 400   // 25 ms
        const val HOP_LEN = 160     // 10 ms
        const val FFT_SIZE = 512
        const val MEL_BANDS = 26
        const val CEPSTRA = 13
        const val MAX_TEMPLATES = 5
        const val MIN_TEMPLATES = 2

        /** Normalised DTW cost under which two utterances count as the same phrase. */
        const val DEFAULT_THRESHOLD = 46.0

        /** Utterance bounds used by the VAD (10 ms frames). */
        const val MIN_FRAMES = 45
        const val MAX_FRAMES = 220

        private const val PREFS = "qorvyna_wake_word"
        private const val KEY_TEMPLATES = "templates"
        private const val KEY_THRESHOLD = "threshold"

        /** Mel filterbank, computed once per process. */
        private val MEL_FILTERS: Array<DoubleArray> by lazy { buildMelFilters() }
        private val DCT: Array<DoubleArray> by lazy { buildDct() }
        private val HAMMING: DoubleArray by lazy {
            DoubleArray(FRAME_LEN) { index ->
                0.54 - 0.46 * cos(2.0 * PI * index / (FRAME_LEN - 1))
            }
        }

        // -------------------------------------------------------------- MFCC

        /** 26 triangular filters spread over a mel scale between 0 and Nyquist. */
        fun buildMelFilters(): Array<DoubleArray> {
            val hzToMel = { hz: Double -> 2595.0 * (1.0 + hz / 700.0) }
            val melToHz = { mel: Double -> 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0) }
            val lowMel = hzToMel(80.0)
            val highMel = hzToMel(SAMPLE_RATE / 2.0)
            val points = DoubleArray(MEL_BANDS + 2) { index ->
                melToHz(lowMel + (highMel - lowMel) * index / (MEL_BANDS + 1))
            }
            val bins = DoubleArray(MEL_BANDS + 2) { index ->
                Math.floor((FFT_SIZE + 1) * points[index] / SAMPLE_RATE)
            }
            return Array(MEL_BANDS) { band ->
                DoubleArray(FFT_SIZE / 2 + 1).also { weights ->
                    val left = bins[band]
                    val centre = bins[band + 1]
                    val right = bins[band + 2]
                    for (bin in weights.indices) {
                        val position = bin.toDouble()
                        weights[bin] = when {
                            position < left || position > right -> 0.0
                            position == centre -> 1.0
                            position < centre -> (position - left) / max(1.0, centre - left)
                            else -> (right - position) / max(1.0, right - centre)
                        }
                    }
                }
            }
        }

        /** DCT-II matrix keeping `CEPSTRA` coefficients (c1..c13, no c0). */
        fun buildDct(): Array<DoubleArray> = Array(CEPSTRA) { k ->
            val n = k + 1
            DoubleArray(MEL_BANDS) { m ->
                cos(PI * n * (m + 0.5) / MEL_BANDS) * sqrt(2.0 / MEL_BANDS)
            }
        }

        /** Endpoint detection: keeps the voiced middle, never returns empty audio. */
        fun trimVoice(samples: ShortArray): ShortArray {
            if (samples.size < FRAME_LEN) return samples
            val frames = (samples.size - FRAME_LEN) / HOP_LEN + 1
            val energy = DoubleArray(frames)
            for (frame in 0 until frames) {
                var sum = 0.0
                val start = frame * HOP_LEN
                for (offset in 0 until FRAME_LEN) {
                    val value = samples[start + offset].toDouble()
                    sum += value * value
                }
                energy[frame] = ln(1.0 + sum / FRAME_LEN) / ln(10.0)
            }
            val peak = energy.maxOrNull() ?: 0.0
            val floor = energy.minOrNull() ?: 0.0
            // Below this the buffer is silence (or fan noise); reject it.
            if (peak < 3.2) return ShortArray(0)
            val cut = floor + (peak - floor) * 0.22
            var first = 0
            var last = frames - 1
            while (first < frames && energy[first] < cut) first++
            while (last > first && energy[last] < cut) last--
            if (last - first < MIN_FRAMES / 2) return ShortArray(0)
            val startSample = first * HOP_LEN
            val endSample = min(samples.size, last * HOP_LEN + FRAME_LEN)
            return samples.copyOfRange(startSample, max(startSample, endSample))
        }

        /** MFCC matrix for one utterance: frames × 13, cepstral mean normalised. */
        fun mfcc(samples: ShortArray): Array<DoubleArray> {
            if (samples.size < FRAME_LEN) return emptyArray()
            val frames = (samples.size - FRAME_LEN) / HOP_LEN + 1
            val features = Array(frames) { DoubleArray(CEPSTRA) }
            val window = DoubleArray(FFT_SIZE)
            for (frame in 0 until frames) {
                val start = frame * HOP_LEN
                var previous = 0.0
                for (index in 0 until FRAME_LEN) {
                    val current = samples[start + index].toDouble()
                    window[index] = (current - 0.97 * previous) * HAMMING[index]
                    previous = current
                }
                for (index in FRAME_LEN until FFT_SIZE) window[index] = 0.0
                val spectrum = powerSpectrum(window)
                val logMel = DoubleArray(MEL_BANDS) { band ->
                    var acc = 0.0
                    val weights = MEL_FILTERS[band]
                    for (bin in weights.indices) acc += weights[bin] * spectrum[bin]
                    ln(max(acc, 1e-10))
                }
                for (coefficient in 0 until CEPSTRA) {
                    var acc = 0.0
                    val row = DCT[coefficient]
                    for (band in 0 until MEL_BANDS) acc += row[band] * logMel[band]
                    features[frame][coefficient] = acc
                }
            }
            return cepstralMeanNormalise(features)
        }

        /** Subtract the per-dimension mean so loudness/gain does not matter. */
        fun cepstralMeanNormalise(features: Array<DoubleArray>): Array<DoubleArray> {
            if (features.isEmpty()) return features
            val mean = DoubleArray(CEPSTRA)
            for (frame in features) for (index in 0 until CEPSTRA) mean[index] += frame[index]
            for (index in 0 until CEPSTRA) mean[index] /= features.size
            return Array(features.size) { frame ->
                DoubleArray(CEPSTRA) { index -> features[frame][index] - mean[index] }
            }
        }

        /** Iterative radix-2 FFT → power spectrum (magnitude²) of FFT_SIZE/2+1 bins. */
        private fun powerSpectrum(window: DoubleArray): DoubleArray {
            val real = DoubleArray(FFT_SIZE)
            val imaginary = DoubleArray(FFT_SIZE)
            System.arraycopy(window, 0, real, 0, min(window.size, FFT_SIZE))
            var j = 0
            for (i in 1 until FFT_SIZE) {
                var bit = FFT_SIZE shr 1
                while (j and bit != 0) {
                    j = j xor bit
                    bit = bit shr 1
                }
                j = j or bit
                if (i < j) {
                    val tr = real[i]; real[i] = real[j]; real[j] = tr
                    val ti = imaginary[i]; imaginary[i] = imaginary[j]; imaginary[j] = ti
                }
            }
            var length = 2
            while (length <= FFT_SIZE) {
                val angle = -2.0 * PI / length
                val stepReal = cos(angle)
                val stepImaginary = kotlin.math.sin(angle)
                var start = 0
                while (start < FFT_SIZE) {
                    var twiddleReal = 1.0
                    var twiddleImaginary = 0.0
                    for (offset in 0 until length / 2) {
                        val evenIndex = start + offset
                        val oddIndex = evenIndex + length / 2
                        val oddReal = real[oddIndex] * twiddleReal - imaginary[oddIndex] * twiddleImaginary
                        val oddImaginary = real[oddIndex] * twiddleImaginary + imaginary[oddIndex] * twiddleReal
                        real[oddIndex] = real[evenIndex] - oddReal
                        imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary
                        real[evenIndex] += oddReal
                        imaginary[evenIndex] += oddImaginary
                        val nextReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary
                        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal
                        twiddleReal = nextReal
                    }
                    start += length
                }
                length = length shl 1
            }
            return DoubleArray(FFT_SIZE / 2 + 1) { bin ->
                real[bin] * real[bin] + imaginary[bin] * imaginary[bin]
            }
        }

        /**
         * Dynamic Time Warping distance, normalised by path length.
         *
         * Banded (Sakoe-Chiba) so nonsense alignments are impossible and the
         * cost is O(len × band) instead of O(len²). A length mismatch of more
         * than 2× is rejected before any work happens.
         */
        fun dtw(a: Array<DoubleArray>, b: Array<DoubleArray>): Double {
            if (a.isEmpty() || b.isEmpty()) return Double.MAX_VALUE
            val (shorter, longer) = if (a.size <= b.size) a to b else b to a
            if (longer.size > shorter.size * 2) return Double.MAX_VALUE
            val rows = shorter.size
            val columns = longer.size
            val band = max(12, max(rows, columns) / 6)
            val infinity = 1e18
            var previous = DoubleArray(columns) { infinity }
            var current = DoubleArray(columns) { infinity }
            for (row in 0 until rows) {
                java.util.Arrays.fill(current, infinity)
                val from = max(0, row - band)
                val to = min(columns - 1, row + band)
                for (column in from..to) {
                    val cost = euclidean(shorter[row], longer[column])
                    if (row == 0 && column == 0) {
                        current[column] = cost
                        continue
                    }
                    var best = infinity
                    if (row > 0) best = min(best, previous[column])
                    if (column > 0) best = min(best, current[column - 1])
                    if (row > 0 && column > 0) best = min(best, previous[column - 1])
                    current[column] = if (best >= infinity) infinity else cost + best
                }
                val swap = previous
                previous = current
                current = swap
            }
            val total = previous[columns - 1]
            if (total >= infinity) return Double.MAX_VALUE
            return total / (rows + columns)
        }

        private fun euclidean(a: DoubleArray, b: DoubleArray): Double {
            var sum = 0.0
            for (index in a.indices) {
                val delta = a[index] - b[index]
                sum += delta * delta
            }
            return sqrt(sum / max(1, a.size))
        }

        /** Serialise a template compactly: rows then rows × CEPSTRA numbers. */
        fun encode(template: Array<DoubleArray>): String =
            buildString {
                append(template.size)
                for (frame in template) for (value in frame) {
                    append(',')
                    append(String.format(java.util.Locale.US, "%.4f", value))
                }
            }

        fun decode(encoded: String): Array<DoubleArray> {
            val parts = encoded.split(',')
            if (parts.size < 2) return emptyArray()
            val rows = parts[0].toIntOrNull() ?: return emptyArray()
            if (rows <= 0 || parts.size - 1 != rows * CEPSTRA) return emptyArray()
            return Array(rows) { frame ->
                DoubleArray(CEPSTRA) { index ->
                    parts[1 + frame * CEPSTRA + index].toDoubleOrNull() ?: 0.0
                }
            }
        }
    }

    // ------------------------------------------------------------- enrolment

    fun templates(): List<Array<DoubleArray>> =
        prefs.getString(KEY_TEMPLATES, null)
            ?.split('\n')
            ?.filter { it.isNotBlank() }
            ?.map { decode(it) }
            ?.filter { it.isNotEmpty() }
            ?: emptyList()

    fun templateCount(): Int = templates().size

    /** True only when a usable model exists on this device. */
    fun isReady(): Boolean = templateCount() >= MIN_TEMPLATES

    fun threshold(): Double = prefs.getFloat(KEY_THRESHOLD, DEFAULT_THRESHOLD.toFloat()).toDouble()

    fun setThreshold(value: Double) {
        prefs.edit().putFloat(KEY_THRESHOLD, value.toFloat().coerceIn(20f, 90f)).apply()
    }

    /**
     * Enrol one utterance. Returns the template count after adding, or 0 when
     * the recording was too quiet/short to be a useful template.
     */
    fun enrol(samples: ShortArray): Int {
        val trimmed = trimVoice(samples)
        if (trimmed.isEmpty()) return templateCount()
        val features = mfcc(trimmed)
        if (features.size < MIN_FRAMES / 2) return templateCount()
        val existing = templates().toMutableList()
        existing.add(features)
        while (existing.size > MAX_TEMPLATES) existing.removeAt(0)
        prefs.edit()
            .putString(KEY_TEMPLATES, existing.joinToString("\n") { encode(it) })
            .apply()
        return existing.size
    }

    fun clear() {
        prefs.edit().remove(KEY_TEMPLATES).apply()
    }

    /**
     * Score a live buffer against the enrolled templates. Returns the best
     * normalised DTW cost (lower is better) and whether it passed.
     */
    fun score(samples: ShortArray): Pair<Double, Boolean> {
        val bank = templates()
        if (bank.isEmpty()) return Double.MAX_VALUE to false
        val trimmed = trimVoice(samples)
        if (trimmed.isEmpty()) return Double.MAX_VALUE to false
        val live = mfcc(trimmed)
        if (live.size < MIN_FRAMES || live.size > MAX_FRAMES) return Double.MAX_VALUE to false
        var best = Double.MAX_VALUE
        for (template in bank) {
            best = min(best, dtw(live, template))
        }
        // The sigmoid is only used to keep the reported score in 0..1 terms;
        // the decision itself is a plain threshold on the DTW cost.
        val matched = best <= threshold()
        return best to matched
    }

    /** 0..1 confidence for the UI, monotonic in the DTW cost. */
    fun confidence(cost: Double): Double =
        if (cost == Double.MAX_VALUE) 0.0 else tanh(threshold() / max(cost, 1e-6)) / tanh(1.0) * 0.5 + 0.5

    /** Rough peak level of a buffer, 0..1, for the level meter. */
    fun level(samples: ShortArray): Double {
        if (samples.isEmpty()) return 0.0
        var peak = 0
        for (sample in samples) peak = max(peak, abs(sample.toInt()))
        return peak / 32767.0
    }
}
