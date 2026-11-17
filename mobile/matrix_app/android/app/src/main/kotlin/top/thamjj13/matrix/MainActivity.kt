package top.thamjj13.matrix

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.projection.MediaProjectionManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.view.KeyEvent
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.EventChannel
import io.flutter.plugin.common.MethodChannel
import java.util.Locale

class MainActivity : FlutterActivity() {

    private val methodChannelName = "top.thamjj13.matrix/native"
    private val eventChannelName = "top.thamjj13.matrix/native_events"

    private val reqAudioPerm = 5101
    private val reqMediaProjection = 5102

    private val mainHandler = Handler(Looper.getMainLooper())
    private var eventSink: EventChannel.EventSink? = null
    private var pendingAssistLaunch = false
    private var pendingSpeechResult: MethodChannel.Result? = null
    private var pendingSpeechLang: String = "en-US"
    private var pendingMirrorResult: MethodChannel.Result? = null

    private var speechRecognizer: SpeechRecognizer? = null
    private var tts: TextToSpeech? = null
    private var ttsReady = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handleIncomingIntent(intent)
        tts = TextToSpeech(this) { status ->
            ttsReady = (status == TextToSpeech.SUCCESS)
        }
        QorvynaNotificationListenerService.onEventCallback = { type, data ->
            emitEvent(type, data)
        }
        QorvynaScreenMirrorService.onFrameBase64 = { dataUrl ->
            emitEvent("mirror_frame", mapOf("data_url" to dataUrl))
        }
        QorvynaScreenMirrorService.onMirrorStopped = {
            emitEvent("mirror_stopped", emptyMap())
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    override fun onDestroy() {
        speechRecognizer?.destroy()
        tts?.shutdown()
        super.onDestroy()
    }

    private fun handleIncomingIntent(intent: Intent?) {
        val action = intent?.action ?: return
        if (action == Intent.ACTION_ASSIST || action == "android.speech.action.VOICE_COMMAND") {
            pendingAssistLaunch = true
            emitEvent("assist_launch", mapOf("action" to action))
        }
    }

    private fun emitEvent(type: String, payload: Map<String, Any>) {
        mainHandler.post {
            eventSink?.success(mapOf("type" to type, "data" to payload))
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        EventChannel(flutterEngine.dartExecutor.binaryMessenger, eventChannelName)
            .setStreamHandler(object : EventChannel.StreamHandler {
                override fun onListen(arguments: Any?, events: EventChannel.EventSink?) {
                    eventSink = events
                }

                override fun onCancel(arguments: Any?) {
                    eventSink = null
                }
            })

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, methodChannelName)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "consumeInitialAssistLaunch" -> {
                        val valOut = pendingAssistLaunch
                        pendingAssistLaunch = false
                        result.success(valOut)
                    }
                    "getDeviceStatus" -> result.success(readDeviceStatus())
                    "isNotificationAccessEnabled" -> result.success(hasNotificationListenerAccess())
                    "openNotificationAccessSettings" -> {
                        startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
                        result.success(true)
                    }
                    "openAssistantSettings" -> {
                        try {
                            startActivity(Intent(Settings.ACTION_VOICE_INPUT_SETTINGS))
                            result.success(true)
                        } catch (_: Throwable) {
                            startActivity(Intent(Settings.ACTION_SETTINGS))
                            result.success(true)
                        }
                    }
                    "listActiveNotifications" -> {
                        val svc = QorvynaNotificationListenerService.instance
                        if (svc != null) {
                            result.success(svc.refreshSnapshot())
                        } else {
                            result.success(QorvynaNotificationListenerService.recent.map { it.toMap() })
                        }
                    }
                    "dismissSystemNotification" -> {
                        val key = call.argument<String>("key").orEmpty()
                        result.success(key.isNotEmpty() && QorvynaNotificationListenerService.dismissByKey(key))
                    }
                    "openInstalledApp" -> {
                        val appName = call.argument<String>("app_name").orEmpty()
                        result.success(launchInstalledApp(appName))
                    }
                    "mediaControl" -> {
                        val action = call.argument<String>("action").orEmpty()
                        result.success(runMediaControl(action))
                    }
                    "speakText" -> {
                        val text = call.argument<String>("text").orEmpty()
                        val lang = call.argument<String>("language") ?: "en-US"
                        val rate = (call.argument<Double>("rate") ?: 1.0).toFloat()
                        result.success(speakOut(text, lang, rate))
                    }
                    "stopSpeaking" -> {
                        tts?.stop()
                        result.success(true)
                    }
                    "startSpeechRecognition" -> {
                        val lang = call.argument<String>("language") ?: "en-US"
                        beginSpeechRecognition(lang, result)
                    }
                    "stopSpeechRecognition" -> {
                        mainHandler.post { speechRecognizer?.stopListening() }
                        result.success(true)
                    }
                    "requestScreenMirrorCapture" -> {
                        beginScreenMirror(result)
                    }
                    "stopScreenMirrorCapture" -> {
                        stopService(Intent(this, QorvynaScreenMirrorService::class.java))
                        result.success(true)
                    }
                    "isScreenMirrorActive" -> result.success(QorvynaScreenMirrorService.isMirroring)
                    else -> result.notImplemented()
                }
            }
    }

    private fun readDeviceStatus(): Map<String, Any> {
        val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val charging = bm.isCharging
        return mapOf(
            "device_model" to "${Build.MANUFACTURER} ${Build.MODEL}",
            "os_version" to "Android ${Build.VERSION.RELEASE}",
            "sdk_int" to Build.VERSION.SDK_INT,
            "battery_percent" to pct,
            "charging" to charging,
            "notification_access" to hasNotificationListenerAccess(),
            "mirror_active" to QorvynaScreenMirrorService.isMirroring
        )
    }

    private fun hasNotificationListenerAccess(): Boolean {
        val cn = ComponentName(this, QorvynaNotificationListenerService::class.java).flattenToString()
        val flat = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: return false
        return flat.split(":").any { it.equals(cn, ignoreCase = true) || it.contains(packageName) }
    }

    private fun launchInstalledApp(query: String): Map<String, Any> {
        val needle = query.trim().lowercase()
        if (needle.isEmpty()) return mapOf("ok" to false, "status" to "invalid", "message" to "Empty app name")

        // 1. Direct package name
        packageManager.getLaunchIntentForPackage(needle)?.let {
            it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(it)
            return mapOf("ok" to true, "status" to "executed", "message" to "Opened $needle")
        }

        // 2. Installed launcher apps match by display label
        val mainIntent = Intent(Intent.ACTION_MAIN, null).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(mainIntent, 0)
        val match = apps.firstOrNull { ri ->
            val label = ri.loadLabel(packageManager).toString().trim().lowercase()
            label == needle || label.contains(needle) || ri.activityInfo.packageName.lowercase().endsWith(".$needle")
        }
        if (match != null) {
            val pkg = match.activityInfo.packageName
            val launch = packageManager.getLaunchIntentForPackage(pkg)
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(launch)
                val label = match.loadLabel(packageManager).toString()
                return mapOf("ok" to true, "status" to "executed", "message" to "Opened $label")
            }
        }
        return mapOf("ok" to false, "status" to "not_supported", "message" to "Installed app \"$query\" was not found on this phone.")
    }

    private fun runMediaControl(action: String): Map<String, Any> {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        when (action.trim().lowercase()) {
            "play_pause", "pause", "play" -> {
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE))
                return mapOf("ok" to true, "status" to "executed", "message" to "Sent media play/pause")
            }
            "next" -> {
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_NEXT))
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_NEXT))
                return mapOf("ok" to true, "status" to "executed", "message" to "Skipped to next track")
            }
            "previous", "prev" -> {
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PREVIOUS))
                am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PREVIOUS))
                return mapOf("ok" to true, "status" to "executed", "message" to "Returned to previous track")
            }
            "volume_up" -> {
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
                return mapOf("ok" to true, "status" to "executed", "message" to "Raised media volume")
            }
            "volume_down" -> {
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
                return mapOf("ok" to true, "status" to "executed", "message" to "Lowered media volume")
            }
            "mute" -> {
                am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
                return mapOf("ok" to true, "status" to "executed", "message" to "Muted media volume")
            }
            else -> return mapOf("ok" to false, "status" to "not_supported", "message" to "Unsupported media action: $action")
        }
    }

    private fun speakOut(text: String, languageTag: String, rate: Float): Boolean {
        val engine = tts ?: return false
        if (!ttsReady || text.isBlank()) return false
        engine.language = Locale.forLanguageTag(languageTag)
        engine.setSpeechRate(rate.coerceIn(0.6f, 1.6f))
        engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "qorvyna_tts_${System.currentTimeMillis()}")
        return true
    }

    private fun beginSpeechRecognition(lang: String, result: MethodChannel.Result) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            pendingSpeechResult = result
            pendingSpeechLang = lang
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.RECORD_AUDIO), reqAudioPerm)
            return
        }
        startRecognizerNow(lang, result)
    }

    private fun startRecognizerNow(lang: String, result: MethodChannel.Result) {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            result.error("UNAVAILABLE", "Android SpeechRecognizer service is not installed on this device.", null)
            return
        }
        mainHandler.post {
            speechRecognizer?.destroy()
            val sr = SpeechRecognizer.createSpeechRecognizer(this)
            speechRecognizer = sr
            var finished = false
            sr.setRecognitionListener(object : RecognitionListener {
                override fun onReadyForSpeech(params: Bundle?) {
                    emitEvent("speech_state", mapOf("state" to "listening"))
                }
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(rmsdB: Float) {}
                override fun onBufferReceived(buffer: ByteArray?) {}
                override fun onEndOfSpeech() {
                    emitEvent("speech_state", mapOf("state" to "processing"))
                }
                override fun onError(error: Int) {
                    if (finished) return
                    finished = true
                    emitEvent("speech_state", mapOf("state" to "idle"))
                    result.error("SPEECH_ERROR_$error", "Could not recognize speech (code $error).", null)
                }
                override fun onResults(results: Bundle?) {
                    if (finished) return
                    finished = true
                    emitEvent("speech_state", mapOf("state" to "idle"))
                    val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    result.success(matches?.firstOrNull().orEmpty())
                }
                override fun onPartialResults(partialResults: Bundle?) {
                    val partial = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()
                    if (!partial.isNullOrEmpty()) {
                        emitEvent("speech_partial", mapOf("text" to partial))
                    }
                }
                override fun onEvent(eventType: Int, params: Bundle?) {}
            })

            val recIntent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, if (lang == "auto") Locale.getDefault().toLanguageTag() else lang)
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            }
            sr.startListening(recIntent)
        }
    }

    private fun beginScreenMirror(result: MethodChannel.Result) {
        if (pendingMirrorResult != null) {
            result.error("BUSY", "Mirror consent prompt is already open.", null)
            return
        }
        pendingMirrorResult = result
        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mgr.createScreenCaptureIntent(), reqMediaProjection)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == reqAudioPerm) {
            val res = pendingSpeechResult
            pendingSpeechResult = null
            if (res != null) {
                if (grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                    startRecognizerNow(pendingSpeechLang, res)
                } else {
                    res.error("PERMISSION_DENIED", "Microphone permission was denied.", null)
                }
            }
        }
    }

    @Deprecated("Deprecated in Android API")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == reqMediaProjection) {
            val res = pendingMirrorResult
            pendingMirrorResult = null
            if (resultCode == Activity.RESULT_OK && data != null) {
                val svcIntent = Intent(this, QorvynaScreenMirrorService::class.java).apply {
                    putExtra(QorvynaScreenMirrorService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(QorvynaScreenMirrorService.EXTRA_DATA, data)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(svcIntent)
                } else {
                    startService(svcIntent)
                }
                res?.success(true)
            } else {
                res?.success(false)
            }
        }
    }
}
