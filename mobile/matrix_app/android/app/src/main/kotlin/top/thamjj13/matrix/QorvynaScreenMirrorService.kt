package top.thamjj13.matrix

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import java.io.ByteArrayOutputStream

class QorvynaScreenMirrorService : Service() {

    companion object {
        const val CHANNEL_ID = "qorvyna_mirror_channel"
        const val NOTIFICATION_ID = 4201
        const val EXTRA_RESULT_CODE = "result_code"
        const val EXTRA_DATA = "result_data"

        @Volatile
        var isMirroring: Boolean = false
            private set

        @Volatile
        var onFrameBase64: ((String) -> Unit)? = null

        @Volatile
        var onMirrorStopped: (() -> Unit)? = null
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private val mainHandler = Handler(Looper.getMainLooper())
    private var lastFrameMs: Long = 0L

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createNotificationChannel()
        val notification = buildActiveNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        val resultCode = intent?.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED) ?: Activity.RESULT_CANCELED
        @Suppress("DEPRECATION")
        val data: Intent? = intent?.getParcelableExtra(EXTRA_DATA)

        if (resultCode != Activity.RESULT_OK || data == null) {
            stopMirrorCleanup()
            stopSelf()
            return START_NOT_STICKY
        }

        val mgr = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        val proj = mgr.getMediaProjection(resultCode, data)
        if (proj == null) {
            stopMirrorCleanup()
            stopSelf()
            return START_NOT_STICKY
        }

        mediaProjection = proj
        isMirroring = true
        proj.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                stopMirrorCleanup()
                stopSelf()
            }
        }, mainHandler)

        val metrics = resources.displayMetrics
        val width = (metrics.widthPixels / 2).coerceIn(360, 720)
        val height = (metrics.heightPixels / 2).coerceIn(640, 1280)
        val dpi = metrics.densityDpi

        val reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        imageReader = reader
        reader.setOnImageAvailableListener({ r ->
            val now = System.currentTimeMillis()
            val img = try { r.acquireLatestImage() } catch (_: Throwable) { null } ?: return@setOnImageAvailableListener
            try {
                // Throttle frame encoding to ~1 fps safe bandwidth snapshot relay
                if (now - lastFrameMs < 950L) return@setOnImageAvailableListener
                lastFrameMs = now
                val plane = img.planes.firstOrNull() ?: return@setOnImageAvailableListener
                val buffer = plane.buffer
                val pixelStride = plane.pixelStride
                val rowStride = plane.rowStride
                val rowPadding = rowStride - pixelStride * width
                val bmp = Bitmap.createBitmap(width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888)
                bmp.copyPixelsFromBuffer(buffer)
                val cropped = Bitmap.createBitmap(bmp, 0, 0, width, height)
                bmp.recycle()
                val out = ByteArrayOutputStream()
                cropped.compress(Bitmap.CompressFormat.JPEG, 55, out)
                cropped.recycle()
                val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                onFrameBase64?.invoke("data:image/jpeg;base64,$b64")
            } catch (_: Throwable) {
                // Ignore frame drop
            } finally {
                img.close()
            }
        }, mainHandler)

        virtualDisplay = proj.createVirtualDisplay(
            "QorvynaMirrorDisplay",
            width,
            height,
            dpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            reader.surface,
            null,
            mainHandler
        )

        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopMirrorCleanup()
        super.onDestroy()
    }

    private fun stopMirrorCleanup() {
        isMirroring = false
        try { virtualDisplay?.release() } catch (_: Throwable) {}
        try { imageReader?.close() } catch (_: Throwable) {}
        try { mediaProjection?.stop() } catch (_: Throwable) {}
        virtualDisplay = null
        imageReader = null
        mediaProjection = null
        onMirrorStopped?.invoke()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val ch = NotificationChannel(
                CHANNEL_ID,
                "Screen Mirroring",
                NotificationManager.IMPORTANCE_LOW
            )
            ch.description = "Visible indicator while QORVYNA is sharing your screen"
            nm.createNotificationChannel(ch)
        }
    }

    private fun buildActiveNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setContentTitle("QORVYNA Screen Mirroring Active")
            .setContentText("Your screen is shared only with your consented device session.")
            .setSmallIcon(android.R.drawable.ic_menu_share)
            .setOngoing(true)
            .build()
    }
}
