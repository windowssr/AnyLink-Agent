package ai.openclaw.app.anylink

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/** Foreground companion service: keeps the WebSocket bus and cross-device worker alive
 * when the app is hidden/backgrounded, without requiring overlay permission first.
 * Also hosts the high-priority heads-up notification channel for proactive messages from 大肥鱼. */
class AnyLinkCompanionService : Service() {
  companion object {
    const val ACTION_TALK = "ai.openclaw.app.anylink.action.TALK"
    const val ACTION_HIDE = "ai.openclaw.app.anylink.action.HIDE"
    const val ACTION_QUIT = "ai.openclaw.app.anylink.action.QUIT"
    private const val CHANNEL = "anylink-companion"
    const val MESSAGE_CHANNEL = "anylink-proactive-messages"
    private const val ID = 42

    fun intent(context: Context, action: String? = null): Intent =
      Intent(context, AnyLinkCompanionService::class.java).apply { if (action != null) this.action = action }

    fun start(context: Context) {
      ensureMessageChannel(context)
      runCatching {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent(context))
        else context.startService(intent(context))
      }
    }

    /** Create the IMPORTANCE_HIGH heads-up notification channel for proactive messages from 大肥鱼. */
    fun ensureMessageChannel(context: Context) {
      if (Build.VERSION.SDK_INT < 26) return
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
      val channel = NotificationChannel(MESSAGE_CHANNEL, "大肥鱼主动消息", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "当大肥鱼主动给你发消息、汇报跨设备任务结果或请求确认时弹出横幅提醒"
        enableVibration(true)
        enableLights(true)
        setShowBadge(true)
      }
      nm.createNotificationChannel(channel)
    }

    /** Pop a heads-up notification banner whenever 大肥鱼 proactively reaches out to the user. */
    fun notifyProactive(context: Context, title: String, body: String, tag: String = "msg", urgent: Boolean = false): Boolean {
      if (body.isBlank()) return false
      if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
        return false
      }
      return runCatching {
        ensureMessageChannel(context)
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
        val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        } ?: Intent(context, AnyLinkActivity::class.java).apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val notifId = 1000 + ((tag.hashCode() and 0x7FFFFFFF) % 30000)
        val open = PendingIntent.getActivity(context, notifId, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val cleanBody = body.trim().take(600)
        val largeIcon = runCatching { BitmapFactory.decodeResource(context.resources, ai.openclaw.app.R.drawable.anylink_avatar) }.getOrNull()
        val builder = NotificationCompat.Builder(context, MESSAGE_CHANNEL)
          .setSmallIcon(ai.openclaw.app.R.drawable.anylink_avatar)
          .setContentTitle(title.ifBlank { "大肥鱼给你发来消息" })
          .setContentText(cleanBody)
          .setStyle(NotificationCompat.BigTextStyle().bigText(cleanBody))
          .setContentIntent(open)
          .setAutoCancel(true)
          .setPriority(if (urgent) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
          .setCategory(NotificationCompat.CATEGORY_MESSAGE)
          .setDefaults(NotificationCompat.DEFAULT_ALL)
          .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        if (largeIcon != null) builder.setLargeIcon(largeIcon)
        nm.notify(notifId, builder.build())
        true
      }.getOrDefault(false)
    }
  }

  override fun onCreate() {
    super.onCreate()
    goForeground()
    AnyLinkRuntime.get(application as android.app.Application).onServiceStarted()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    goForeground()
    when (intent?.action) {
      ACTION_TALK -> { AnyLinkRuntime.get(application as android.app.Application).startListening() }
      ACTION_HIDE -> { AnyLinkRuntime.get(application as android.app.Application).dismissOverlay() }
      ACTION_QUIT -> { stopSelf(); return START_NOT_STICKY }
    }
    return START_STICKY
  }

  private fun goForeground() {
    val runtime = AnyLinkRuntime.get(application as android.app.Application)
    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26) {
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "大肥鱼后台在线", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
      ensureMessageChannel(this)
    }
    fun action(label: String, action: String, request: Int) = NotificationCompat.Action.Builder(
      0, label,
      PendingIntent.getService(this, request, intent(this, action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE),
    ).build()
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)?.apply {
      addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val open = PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val statusText = if (runtime.wsOnline.value) "WebSocket 实时在线 · 后台待命" else "云端同步中 · 点按打开对话"
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(ai.openclaw.app.R.drawable.anylink_avatar)
      .setContentTitle("大肥鱼 · AnyLink")
      .setContentText(statusText)
      .setContentIntent(open)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .addAction(action("说话", ACTION_TALK, 1))
      .addAction(action("隐藏悬浮", ACTION_HIDE, 2))
      .addAction(action("退出", ACTION_QUIT, 3))
      .build()
    // Start safely with SPECIAL_USE first (adding MICROPHONE only when permission is granted); never crash the app.
    val preferredTypes = if (runtime.micGranted()) {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    } else {
      ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    }
    try {
      ServiceCompat.startForeground(this, ID, notification, preferredTypes)
    } catch (_: Exception) {
      try {
        ServiceCompat.startForeground(this, ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } catch (_: Exception) {
        runtime.voiceNotice.value = "系统省电策略限制了后台保活，可前往应用电池设置设为无限制。"
        stopSelf()
      }
    }
  }

  override fun onDestroy() {
    AnyLinkRuntime.get(application as android.app.Application).onServiceStopped()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
