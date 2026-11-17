package top.thamjj13.matrix

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import java.util.Collections

data class CapturedNotification(
    val key: String,
    val packageName: String,
    val appName: String,
    val title: String,
    val body: String,
    val category: String,
    val postTime: Long,
    val isOngoing: Boolean
) {
    fun toMap(): Map<String, Any> = mapOf(
        "external_key" to key,
        "package_name" to packageName,
        "app_name" to appName,
        "title" to title,
        "body" to body,
        "category" to category,
        "posted_at_ms" to postTime,
        "is_ongoing" to isOngoing
    )
}

class QorvynaNotificationListenerService : NotificationListenerService() {

    companion object {
        @Volatile
        var instance: QorvynaNotificationListenerService? = null
            private set

        @Volatile
        var onEventCallback: ((String, Map<String, Any>) -> Unit)? = null

        val recent: MutableList<CapturedNotification> = Collections.synchronizedList(mutableListOf())

        fun dismissByKey(key: String): Boolean {
            val svc = instance ?: return false
            return try {
                svc.cancelNotification(key)
                synchronized(recent) {
                    recent.removeAll { it.key == key }
                }
                true
            } catch (_: Throwable) {
                false
            }
        }
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
        // Ignore our own screen-mirroring persistent status notification or ongoing media bars
        if (item.packageName == packageName || item.isOngoing) return
        synchronized(recent) {
            recent.removeAll { it.key == item.key }
            recent.add(0, item)
            while (recent.size > 60) {
                recent.removeAt(recent.size - 1)
            }
        }
        onEventCallback?.invoke("notification_posted", item.toMap())
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        val k = sbn?.key ?: return
        synchronized(recent) {
            recent.removeAll { it.key == k }
        }
        onEventCallback?.invoke("notification_removed", mapOf("external_key" to k))
    }

    fun refreshSnapshot(): List<Map<String, Any>> {
        val list = try {
            activeNotifications?.mapNotNull { convert(it) }?.filter {
                it.packageName != packageName && !it.isOngoing
            } ?: emptyList()
        } catch (_: Throwable) {
            emptyList()
        }
        synchronized(recent) {
            recent.clear()
            recent.addAll(list.take(60))
        }
        return list.map { it.toMap() }
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
            body = text,
            category = sbn.notification.category ?: "general",
            postTime = sbn.postTime,
            isOngoing = isOngoing
        )
    }
}
