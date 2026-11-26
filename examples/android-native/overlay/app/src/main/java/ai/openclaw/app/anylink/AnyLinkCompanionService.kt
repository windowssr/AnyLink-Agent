package ai.openclaw.app.anylink

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/** Foreground companion service: keeps the WebSocket bus and cross-device worker alive
 * when the app is hidden/backgrounded, without requiring overlay permission first. */
class AnyLinkCompanionService : Service() {
  companion object {
    const val ACTION_TALK = "ai.openclaw.app.anylink.action.TALK"
    const val ACTION_HIDE = "ai.openclaw.app.anylink.action.HIDE"
    const val ACTION_QUIT = "ai.openclaw.app.anylink.action.QUIT"
    private const val CHANNEL = "anylink-companion"
    private const val ID = 42

    fun intent(context: Context, action: String? = null): Intent =
      Intent(context, AnyLinkCompanionService::class.java).apply { if (action != null) this.action = action }

    fun start(context: Context) {
      runCatching {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent(context))
        else context.startService(intent(context))
      }
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
