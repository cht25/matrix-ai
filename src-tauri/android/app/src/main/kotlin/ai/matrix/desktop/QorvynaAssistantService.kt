package ai.matrix.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.TextView
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * QORVYNA floating assistant service (Android).
 *
 * A real foreground service that does three things:
 *
 *   1. gives the app the assistant role — the `ASSIST` intent lands here via
 *      [AssistActivity], so once the user picks QORVYNA in Settings → Apps →
 *      Default apps → Digital assistant the system gesture opens QORVYNA;
 *   2. keeps a draggable floating bubble on screen (needs “Display over other
 *      apps”; requested explicitly, never assumed — the bubble is simply not
 *      drawn when the grant is missing, and `state` reports the truth);
 *   3. listens for the enrolled wake phrase with [QorvynaWakeWord] — MFCC +
 *      DTW on the device, no network at all — and starts a voice turn when it
 *      hears it.
 *
 * Communication with the webview goes through the command results in
 * [AssistantPlugin] plus a persisted “pending turn” flag, never through a
 * fire-and-forget broadcast that could be dropped while the app is paused.
 */
class QorvynaAssistantService : Service() {

    companion object {
        const val ACTION_START = "ai.matrix.desktop.assistant.START"
        const val ACTION_STOP = "ai.matrix.desktop.assistant.STOP"

        const val EXTRA_SOURCE = "qorvyna_assistant"

        private const val CHANNEL_ID = "qorvyna_assistant"
        private const val NOTIFICATION_ID = 4211
        private const val PREFS = "qorvyna_wake_word"
        private const val KEY_PENDING = "pending_wake"
        private const val KEY_WAKE_ENABLED = "wake_enabled"

        @Volatile
        private var running = false

        /** Live instance while the service is bound to the process (if any). */
        @Volatile
        private var instance: QorvynaAssistantService? = null

        fun isRunning(): Boolean = running

        fun canDrawOverlays(context: Context): Boolean =
            Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context)

        fun isDefaultAssistant(context: Context): Boolean = try {
            val intent = Intent(Intent.ACTION_ASSIST).addCategory(Intent.CATEGORY_DEFAULT)
            val resolved = context.packageManager.resolveActivity(intent, 0)
            resolved?.activityInfo?.packageName == context.packageName
        } catch (_: Throwable) {
            false
        }

        /** What Rust reports as `wakeWordReady`: a usable on-device model exists. */
        fun wakeWordReady(context: Context): Boolean = QorvynaWakeWord(context).isReady()

        fun isWakeEnabled(context: Context): Boolean =
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_WAKE_ENABLED, true)

        fun setWakeEnabled(context: Context, enabled: Boolean) {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_WAKE_ENABLED, enabled).apply()
            val live = instance ?: return
            if (enabled) live.startListening() else live.stopListening()
        }

        fun requestStart(context: Context) {
            val intent = Intent(context, QorvynaAssistantService::class.java).setAction(ACTION_START)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent)
                else context.startService(intent)
            } catch (_: Throwable) {
                // Background-start restrictions (Android 12+): the next launch
                // of the app starts the service from the foreground instead.
            }
        }

        fun requestStop(context: Context) {
            context.startService(
                Intent(context, QorvynaAssistantService::class.java).setAction(ACTION_STOP),
            )
        }

        /** Consume the “a turn was requested while the UI was away” flag. */
        fun takePending(context: Context): Boolean {
            val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            val pending = prefs.getBoolean(KEY_PENDING, false)
            if (pending) prefs.edit().putBoolean(KEY_PENDING, false).apply()
            return pending
        }

        /**
         * Record one enrolment sample (≈3 s) and store its MFCC template.
         * `onResult(templates, detail)` runs on a worker thread.
         */
        fun enrolOnce(context: Context, onResult: (Int, String) -> Unit) {
            val engine = QorvynaWakeWord(context)
            // The wake loop owns the microphone; pause it for the sample.
            instance?.stopListening()
            Thread {
                val seconds = 3
                val total = QorvynaWakeWord.SAMPLE_RATE * seconds
                val samples = ShortArray(total)
                var record: AudioRecord? = null
                try {
                    record = AudioRecord(
                        MediaRecorder.AudioSource.VOICE_RECOGNITION,
                        QorvynaWakeWord.SAMPLE_RATE,
                        AudioFormat.CHANNEL_IN_MONO,
                        AudioFormat.ENCODING_PCM_16BIT,
                        total * 2,
                    )
                    if (record.state != AudioRecord.STATE_INITIALIZED) {
                        record.release()
                        onResult(0, "The microphone is unavailable. Check the QORVYNA microphone permission.")
                        return@Thread
                    }
                    record.startRecording()
                    var offset = 0
                    while (offset < total) {
                        val read = record.read(samples, offset, total - offset)
                        if (read <= 0) break
                        offset += read
                    }
                    record.stop()
                    record.release()
                    record = null
                    if (offset < QorvynaWakeWord.SAMPLE_RATE / 2) {
                        onResult(0, "Nothing was recorded. Try again in a quieter room.")
                        return@Thread
                    }
                    val count = engine.enrol(samples.copyOfRange(0, offset))
                    val ready = engine.isReady()
                    if (ready) {
                        // Enrolling the phrase is the consent to listen for it.
                        setWakeEnabled(context, true)
                    }
                    onResult(
                        count,
                        if (ready) "Wake phrase ready ($count samples on this device). Say it from any screen."
                        else "Sample $count of ${QorvynaWakeWord.MIN_TEMPLATES} saved. Repeat the phrase " +
                            "${QorvynaWakeWord.MIN_TEMPLATES - count} more time(s).",
                    )
                } catch (error: Throwable) {
                    try {
                        record?.release()
                    } catch (_: Throwable) {
                        // Ignore.
                    }
                    onResult(0, "Enrolment failed: ${error.message ?: error.javaClass.simpleName}")
                }
            }.start()
        }

        /** Forget every enrolled sample. */
        fun clearTemplates(context: Context): Int {
            QorvynaWakeWord(context).clear()
            setWakeEnabled(context, false)
            instance?.stopListening()
            return 0
        }
    }

    private val handler = Handler(Looper.getMainLooper())
    private val wakeWord by lazy { QorvynaWakeWord(this) }

    private var windowManager: WindowManager? = null
    private var bubble: View? = null

    @Volatile private var listening = false
    private var audioThread: Thread? = null
    private var recorder: AudioRecord? = null

    private var lastHitAt = 0L
    private var consecutiveHits = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        createChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            shutdown()
            return START_NOT_STICKY
        }
        running = true
        startForeground(NOTIFICATION_ID, buildNotification())
        if (canDrawOverlays(this)) showBubble()
        if (wakeWord.isReady() && isWakeEnabled(this)) startListening()
        return START_STICKY
    }

    override fun onDestroy() {
        shutdown()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun shutdown() {
        running = false
        stopListening()
        removeBubble()
        stopForeground(true)
        stopSelf()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "QORVYNA assistant",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Keeps the floating bubble and the on-device wake phrase ready."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this,
            1,
            Intent(this, QorvynaAssistantService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("QORVYNA assistant")
            .setContentText(
                if (wakeWord.isReady()) "Listening for your wake phrase on this device."
                else "Tap the bubble to talk. Enrol the wake phrase in QORVYNA settings.",
            )
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    // ----------------------------------------------------------------- bubble

    private fun showBubble() {
        if (bubble != null) return
        val manager = windowManager ?: return
        val size = (56 * resources.displayMetrics.density).roundToInt()
        val label = TextView(this).apply {
            text = "Q"
            setTextColor(Color.WHITE)
            textSize = 22f
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.parseColor("#1F6FEB"))
            }
            contentDescription = "Open QORVYNA assistant"
            setOnClickListener { startTurn("bubble") }
        }
        val params = WindowManager.LayoutParams(
            size,
            size,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
            else
                @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            android.graphics.PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = resources.displayMetrics.widthPixels - size - 24
            y = resources.displayMetrics.heightPixels / 2
        }
        // Drag to move; a release without movement is a tap.
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        label.setOnTouchListener { view, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (event.rawX - touchX).roundToInt()
                    params.y = startY + (event.rawY - touchY).roundToInt()
                    try {
                        manager.updateViewLayout(view, params)
                    } catch (_: Throwable) {
                        // The overlay window was revoked mid-drag.
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (abs(event.rawX - touchX) + abs(event.rawY - touchY) < 12f) view.performClick()
                    true
                }
                else -> false
            }
        }
        try {
            manager.addView(label, params)
            bubble = label
        } catch (_: Throwable) {
            bubble = null
        }
    }

    private fun removeBubble() {
        val view = bubble ?: return
        bubble = null
        try {
            windowManager?.removeView(view)
        } catch (_: Throwable) {
            // Already detached.
        }
    }

    // -------------------------------------------------------------- wake word

    @Synchronized
    private fun startListening() {
        if (listening || !wakeWord.isReady()) return
        listening = true
        audioThread = Thread({ captureLoop() }, "qorvyna-wake").also {
            it.isDaemon = true
            it.start()
        }
    }

    @Synchronized
    private fun stopListening() {
        listening = false
        try {
            recorder?.stop()
        } catch (_: Throwable) {
            // Not recording.
        }
        recorder?.release()
        recorder = null
        audioThread = null
    }

    /** Continuous capture over a 2 s sliding window, scored every 250 ms. */
    private fun captureLoop() {
        val engine = wakeWord
        val rate = QorvynaWakeWord.SAMPLE_RATE
        val windowSize = rate * 2
        val window = ShortArray(windowSize)
        var filled = 0
        val chunk = 1600 // 100 ms
        val buffer = ShortArray(chunk)
        val minBuffer = rate / 2 // 500 ms before the first score

        val record = try {
            AudioRecord(
                MediaRecorder.AudioSource.VOICE_RECOGNITION,
                rate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                chunk * 4,
            )
        } catch (_: Throwable) {
            null
        }
        if (record == null || record.state != AudioRecord.STATE_INITIALIZED) {
            record?.release()
            listening = false
            return
        }
        recorder = record
        try {
            record.startRecording()
        } catch (_: Throwable) {
            record.release()
            recorder = null
            listening = false
            return
        }

        var lastScoreAt = SystemClock.elapsedRealtime()
        while (listening) {
            val read = try {
                record.read(buffer, 0, buffer.size)
            } catch (_: Throwable) {
                -1
            }
            if (read <= 0) {
                Thread.sleep(20)
                continue
            }
            if (read >= windowSize) {
                System.arraycopy(buffer, read - windowSize, window, 0, windowSize)
                filled = windowSize
            } else {
                System.arraycopy(window, read, window, 0, windowSize - read)
                System.arraycopy(buffer, 0, window, windowSize - read, read)
                filled = min(windowSize, filled + read)
            }
            val now = SystemClock.elapsedRealtime()
            if (now - lastScoreAt < 250 || filled < minBuffer) continue
            lastScoreAt = now
            val snapshot = window.copyOfRange(windowSize - filled, windowSize)
            val (cost, matched) = engine.score(snapshot)
            tally(cost, matched)
        }
        try {
            record.stop()
        } catch (_: Throwable) {
            // Already released.
        }
        record.release()
        recorder = null
    }

    /** Two consecutive hits, at most one turn every three seconds. */
    private fun tally(cost: Double, matched: Boolean) {
        if (!matched || cost == Double.MAX_VALUE) {
            consecutiveHits = 0
            return
        }
        consecutiveHits += 1
        val now = SystemClock.elapsedRealtime()
        if (consecutiveHits < 2 || now - lastHitAt < 3000) return
        lastHitAt = now
        consecutiveHits = 0
        startTurn("wake")
    }

    /** Mark a pending turn and bring the app forward to run it. */
    private fun startTurn(source: String) {
        getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean(KEY_PENDING, true).apply()
        try {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra(EXTRA_SOURCE, source)
                    .setData(Uri.parse("qorvyna://assistant?source=$source")),
            )
        } catch (_: Throwable) {
            // The pending flag still opens the assistant on the next launch.
        }
    }
}
