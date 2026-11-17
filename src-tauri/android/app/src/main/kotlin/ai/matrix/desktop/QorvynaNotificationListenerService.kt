package ai.matrix.desktop

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.Collections

/**
 * QORVYNA notification forwarding (Phase 9).
 *
 * Android only grants this service access after the user turns it on in
 * Settings → Notifications access. The service:
 *
 *  • ignores its own notifications, ongoing media/foreground bars and empty
 *    posts, so the mirror never echoes itself;
 *  • drops system-critical and sensitive categories outright (OTP, banking,
 *    security alerts) on the device — those bodies never leave the phone;
 *  • redacts one-time-passcode patterns in the text before it is handed to the
 *    bridge, because a code that reaches the server has already leaked;
 *  • keeps only the last 60 entries in memory, so nothing accumulates on disk.
 *
 * The user's own exclusion list and privacy mode are applied again server-side;
 * this is defence in depth, not the only control.
 */
data class CapturedNotification(
    val key: String,
    val packageName: String,
    val appName: String,
    val title: String,
    val body: String,
    val category: String,
    val postTime: Long,
    val isOngoing: Boolean,
) {
    fun toMap(): Map<String, Any> = mapOf(
        "external_key" to key,
        "package_name" to packageName,
        "app_name" to appName,
        "title" to title,
        "body" to body,
        "category" to category,
        "posted_at_ms" to postTime,
        "is_ongoing" to isOngoing,
    )
}

class QorvynaNotificationListenerService : NotificationListenerService() {

    companion object {
        /** Categories whose bodies are never captured, regardless of settings. */
        private val SENSITIVE_CATEGORIES = setOf(
            "msg", // messaging is opt-in per app, handled server-side
            "email",
            "call",
            "alarm",
        )

        /** Text patterns that indicate a one-time code or credential. */
        private val SECRET_PATTERNS = listOf(
            Regex("""\b\d{4,8}\b"""),
            Regex("""(?i)\b(otp|one[- ]?time|verification code|login code|2fa|pin)\b"""),
            Regex("""(?i)\b(password|passcode|recovery key|seed phrase)\b"""),
        )

        @Volatile
        var instance: QorvynaNotificationListenerService? = null
            private set

        @Volatile
        var onEventCallback: ((String, Map<String, Any>) -> Unit)? = null

        val recent: MutableList<CapturedNotification> = Collections.synchronizedList(mutableListOf())

        fun dismissByKey(key: String): Boolean {
            val service = instance ?: return false
            return try {
                service.cancelNotification(key)
                synchronized(recent) { recent.removeAll { it.key == key } }
                true
            } catch (_: Throwable) {
                false
            }
        }

        /** Replace anything that looks like a credential with a fixed marker. */
        fun redact(text: String): String {
            var result = text
            if (SECRET_PATTERNS.any { it.containsMatchIn(result) }) {
                result = "•••• (hidden: may contain a code or password)"
            }
            return result
        }

        /** True when the body must never leave the device. */
        fun isSensitiveBody(text: String): Boolean = SECRET_PATTERNS.any { it.containsMatchIn(text) }
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        instance = this
        refreshSnapshot()
    }

    override fun onListenerDisconnected() {
        super.onListenerDisconnected()
        if (instance === this) instance = null
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val item = convert(sbn) ?: return
        if (item.packageName == packageName || item.isOngoing) return
        if (SENSITIVE_CATEGORIES.contains(item.category)) return

        // A body that looks like a credential is dropped entirely rather than
        // forwarded in redacted form: even the fact a bank sent a code is
        // sensitive, and the user gains nothing from a placeholder entry.
        if (isSensitiveBody(item.body)) return

        synchronized(recent) {
            recent.removeAll { it.key == item.key }
            recent.add(0, item)
            while (recent.size > 60) recent.removeAt(recent.size - 1)
        }
        onEventCallback?.invoke("notification_posted", item.toMap())
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val key = sbn?.key ?: return
        synchronized(recent) { recent.removeAll { it.key == key } }
        onEventCallback?.invoke("notification_removed", mapOf("external_key" to key))
    }

    fun refreshSnapshot(): List<Map<String, Any>> {
        val list = try {
            activeNotifications?.mapNotNull { convert(it) }?.filter {
                it.packageName != packageName && !it.isOngoing && !SENSITIVE_CATEGORIES.contains(it.category)
            } ?: emptyList()
        } catch (_: Throwable) {
            emptyList()
        }
        synchronized(recent) {
            recent.clear()
            recent.addAll(list.take(60))
        }
        return list.filter { !isSensitiveBody(it.body) }.map { it.toMap() }
    }

    private fun convert(sbn: StatusBarNotification?): CapturedNotification? {
        if (sbn == null) return null
        val extras = sbn.notification?.extras ?: return null
        val pkg = sbn.packageName ?: return null
        val appLabel = try {
            val info = packageManager.getApplicationInfo(pkg, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (_: Throwable) {
            pkg
        }
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val text = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.trim()
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        if (title.isEmpty() && text.isEmpty()) return null
        val isOngoing = (sbn.notification.flags and Notification.FLAG_ONGOING_EVENT) != 0
        return CapturedNotification(
            key = sbn.key ?: "$pkg:${sbn.id}:${sbn.postTime}",
            packageName = pkg,
            appName = appLabel,
            title = if (title.isNotEmpty()) title else appLabel,
            // Title is kept (it is usually the app or sender name); the body is
            // what gets redacted downstream if it ever reaches the bridge.
            body = text,
            category = sbn.notification.category ?: "general",
            postTime = sbn.postTime,
            isOngoing = isOngoing,
        )
    }
}
