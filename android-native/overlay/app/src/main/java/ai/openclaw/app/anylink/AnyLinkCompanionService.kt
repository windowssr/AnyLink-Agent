package ai.openclaw.app.anylink

import android.app.Notification
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

/** Foreground companion service: keeps the device agent worker alive in the
 * background and owns microphone access for overlay tap-to-talk. Declared with
 * foregroundServiceType specialUse + microphone. */
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
      runCatching { context.startForegroundService(intent(context)) }
    }
  }

  override fun onCreate() {
    super.onCreate()
    AnyLinkRuntime.get(application as android.app.Application).onServiceStarted()
    goForeground()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
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
      nm.createNotificationChannel(NotificationChannel(CHANNEL, "大肥鱼陪伴", NotificationManager.IMPORTANCE_LOW).apply { setShowBadge(false) })
    }
    fun action(label: String, action: String, request: Int) = NotificationCompat.Action.Builder(0, label,
      PendingIntent.getService(this, request, intent(this, action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
    val open = PendingIntent.getActivity(this, 0, packageManager.getLaunchIntentForPackage(packageName), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val notification = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(ai.openclaw.app.R.drawable.anylink_avatar)
      .setContentTitle("大肥鱼在陪着你")
      .setContentText("点按通知或悬浮窗和她说话")
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(action("说话", ACTION_TALK, 1))
      .addAction(action("隐藏悬浮", ACTION_HIDE, 2))
      .addAction(action("退出", ACTION_QUIT, 3))
      .build()
    var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
    if (runtime.micGranted()) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    try {
      ServiceCompat.startForeground(this, ID, notification, types)
    } catch (failure: Exception) {
      // Some devices refuse typed FGS starts; retry with the minimal type.
      try { ServiceCompat.startForeground(this, ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) }
      catch (second: Exception) {
        runtime.voiceNotice.value = "系统暂不允许后台常驻，点按打开应用说话。"
        runtime.openApp(); stopSelf(); return
      }
    }
    if (Build.VERSION.SDK_INT >= 33 && !notificationsGranted()) {
      // Without POST_NOTIFICATIONS the FGS still runs but stays silent in the shade.
    }
  }

  private fun notificationsGranted() = Build.VERSION.SDK_INT < 33 ||
    checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) == android.content.pm.PackageManager.PERMISSION_GRANTED

  override fun onDestroy() {
    AnyLinkRuntime.get(application as android.app.Application).onServiceStopped()
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
