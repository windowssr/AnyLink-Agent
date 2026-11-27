package ai.openclaw.app.anylink

import android.content.Intent
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.unit.dp
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AnyLinkCloudUiTest {
  @get:Rule val compose = createComposeRule()

  @Test fun `launcher and quick password setup belong to the local agent not OpenClaw pairing`() {
    val app = RuntimeEnvironment.getApplication()
    val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
    assertEquals("ai.openclaw.app.anylink.AnyLinkActivity", launch?.component?.className)
    val permissions = app.packageManager.getPackageInfo(app.packageName, android.content.pm.PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty()
    assertFalse(permissions.contains("android.permission.READ_SMS")); assertFalse(permissions.contains("android.permission.ACCESS_BACKGROUND_LOCATION"))
    assertNull(app.packageManager.resolveActivity(Intent().setClassName(app, "ai.openclaw.app.MainActivity"), 0))
    compose.setContent {
      MaterialTheme(colorScheme = DeepSeaColorScheme) {
        CloudCompanionScreen(LocalAgentState(), null, "", false, "", "", false, false, false, emptyList(), true, {}, {}, { _, _, _, _, _ -> }, {}, {}, {}, {})
      }
    }
    compose.onNodeWithText("连接 AnyLink 服务器").assertExists()
    compose.onNodeWithText("HTTPS 服务器地址").assertExists()
    compose.onNodeWithText("登录密码 / 加入密钥").assertExists()
    compose.onNodeWithText("高级选项（设备名称、短别名、导入旧凭据）").performClick()
    compose.onNodeWithText("设备短别名（可选，如 my-phone）").assertExists()
    compose.onNodeWithText("导入旧版设备凭据 JSON").performClick()
    compose.onNodeWithText("设备凭据 JSON").assertExists()
    compose.onNodeWithText("连接我的 Mac").assertDoesNotExist()
    System.getenv("ANYLINK_SCREENSHOT_DIR")?.let { directory ->
      val file = java.io.File(directory, "android-server-connection.png"); file.parentFile?.mkdirs()
      file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
  }

  @Test fun `deep-sea glass UI renders full multi-turn messages, v32 approval cards, and task receipts`() {
    val fileTask = linkJson.parseToJsonElement("""{"id":"33333333-3333-4333-8333-333333333333","capability":"files.search","state":"succeeded","result":{"state":"succeeded","output":{"matches":[{"name":"report.txt","path":"/Workspace/report.txt"}],"partial":true}}}""").jsonObject
    val invokeTask = linkJson.parseToJsonElement("""{"id":"44444444-4444-4444-8444-444444444444","capability":"agent.invoke","instruction":"帮我总结桌面的周报","state":"succeeded","result":{"state":"succeeded","output":{"reply":"周报已整理并汇总 3 条进展。"}}}""").jsonObject
    val declinedTask = linkJson.parseToJsonElement("""{"id":"55555555-5555-4555-8555-555555555555","capability":"agent.invoke","instruction":"发微信给老板","state":"declined","result":{"state":"declined","error":{"code":"UNSUPPORTED","message":"Mac 端无法直接发送微信消息"}}}""").jsonObject
    var repliedApproval: Pair<String, Boolean?>? = null
    val chatState = LocalAgentState(
      chat = listOf(
        ChatMessage("u1", "user", "帮我把文件写到电脑桌面"),
        ChatMessage("a1", "assistant", "哼，小事一桩嘛！已经帮你写好了，就在 /Users/demo/Desktop/hello.txt。", meta = "已调用：安排跨设备任务"),
        ChatMessage(
          id = "int-1",
          role = "interaction",
          text = "准备清理 ~/Downloads 中的旧安装包（1.2 GB），确认移到废纸篓吗？",
          meta = "跨设备高危审批",
          taskId = "66666666-6666-4666-8666-666666666666",
          interactionType = "awaiting_approval",
          riskLevel = "high",
        ),
      ),
    )
    compose.setContent {
      MaterialTheme(colorScheme = DeepSeaColorScheme) {
        CloudCompanionScreen(
          state = chatState,
          server = "https://example.invalid",
          deviceSlug = "my-phone",
          wsOnline = true,
          error = "",
          voiceNotice = "",
          connecting = false,
          listening = false,
          speaking = false,
          tasks = listOf(fileTask, invokeTask, declinedTask),
          showConfiguration = false,
          openConfiguration = {},
          closeConfiguration = {},
          connect = { _, _, _, _, _ -> },
          send = {},
          stop = {},
          listen = {},
          newConversation = {},
          replyTask = { id, approved, _, _ -> repliedApproval = id to approved },
        )
      }
    }
    compose.onNodeWithText("Protocol v3.2 · @my-phone · WS 实时在线").assertExists()
    compose.onNodeWithText("哼，小事一桩嘛！已经帮你写好了，就在 /Users/demo/Desktop/hello.txt。").assertExists()
    compose.onNodeWithText("批准执行").assertExists()

    System.getenv("ANYLINK_SCREENSHOT_DIR")?.let { directory ->
      val file = java.io.File(directory, "android-companion-v09.png"); file.parentFile?.mkdirs()
      file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    compose.onNodeWithText("展开阅读 ⌃").performClick()
    compose.onNodeWithText("陪伴视图 ⌄").assertExists()
    compose.onNodeWithText("帮我把文件写到电脑桌面").assertExists()
    System.getenv("ANYLINK_SCREENSHOT_DIR")?.let { directory ->
      val file = java.io.File(directory, "android-reading-v09.png"); file.parentFile?.mkdirs()
      file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    compose.onNodeWithText("批准执行").performClick()
    assertEquals("66666666-6666-4666-8666-666666666666" to true, repliedApproval)

    compose.onNodeWithText("任务(3)").performClick()
    compose.onNodeWithText("report.txt").assertExists()
    compose.onNodeWithText("/Workspace/report.txt").assertExists()
    compose.onNodeWithText("搜索覆盖有限，未遍历全部文件。").assertExists()
    compose.onNodeWithText("周报已整理并汇总 3 条进展。").assertExists()
    compose.onNodeWithText("Mac 端无法直接发送微信消息").assertExists()
  }

  @Test fun `proactive messages post IMPORTANCE_HIGH heads-up notification and floating bubble centers avatar`() {
    val app = RuntimeEnvironment.getApplication()
    org.robolectric.Shadows.shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
    val posted = AnyLinkCompanionService.notifyProactive(
      app,
      title = "大肥鱼：跨设备任务办妥啦",
      body = "飞书消息已经帮你发好啦！",
      tag = "task:test-notify-1",
    )
    assertTrue(posted)
    val nm = app.getSystemService(android.content.Context.NOTIFICATION_SERVICE) as android.app.NotificationManager
    val channel = nm.getNotificationChannel(AnyLinkCompanionService.MESSAGE_CHANNEL)
    assertNotNull(channel)
    assertEquals(android.app.NotificationManager.IMPORTANCE_HIGH, channel.importance)
    val active = org.robolectric.Shadows.shadowOf(nm).allNotifications
    assertTrue(active.any { it.extras.getString(android.app.Notification.EXTRA_TITLE) == "大肥鱼：跨设备任务办妥啦" && it.extras.getString(android.app.Notification.EXTRA_TEXT) == "飞书消息已经帮你发好啦！" })

    compose.setContent {
      MaterialTheme(colorScheme = DeepSeaColorScheme) {
        androidx.compose.foundation.layout.Box(
          androidx.compose.ui.Modifier.size(96.dp, 124.dp),
        ) {
          OverlayBubbleCard(ringColor = androidx.compose.ui.graphics.Color(0xFF468CAF), caption = "在线")
        }
      }
    }
    compose.onNodeWithText("在线").assertExists()
    System.getenv("ANYLINK_SCREENSHOT_DIR")?.let { directory ->
      val file = java.io.File(directory, "floating-bubble-v09.png"); file.parentFile?.mkdirs()
      file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
  }

  @Test fun `bidirectional file transfer saves sanitized files and renders file card with attachment picker`() {
    val app = RuntimeEnvironment.getApplication()
    val payload = "hello-from-mac-pdf".toByteArray()
    val saved = AnyLinkFiles.saveReceivedFile(app, payload, "../evil/周报.pdf", "application/pdf")
    assertEquals("周报.pdf", saved.filename)
    assertEquals(payload.size, saved.sizeBytes)
    assertNotNull(saved.uri)

    var pickedClicked = false
    var sentTriggered = false
    val stateWithFile = LocalAgentState(
      chat = listOf(
        ChatMessage(
          id = "f1",
          role = "event",
          text = "已收到来自 Mac 的文件《周报.pdf》",
          meta = "收到来自 Mac 的文件",
          fileName = "周报.pdf",
          fileUri = saved.uri.toString(),
          fileMime = "application/pdf",
          fileSize = 1572864L,
          fileLocation = "下载/AnyLink/周报.pdf",
        ),
      ),
    )
    compose.setContent {
      MaterialTheme(colorScheme = DeepSeaColorScheme) {
        CloudCompanionScreen(
          state = stateWithFile,
          server = "https://example.invalid",
          deviceSlug = "my-phone",
          wsOnline = true,
          error = "",
          voiceNotice = "",
          connecting = false,
          listening = false,
          speaking = false,
          tasks = emptyList(),
          showConfiguration = false,
          openConfiguration = {},
          closeConfiguration = {},
          connect = { _, _, _, _, _ -> },
          send = { sentTriggered = true },
          stop = {},
          listen = {},
          newConversation = {},
          pendingFile = PickedFile(android.net.Uri.parse("content://test/contract.pdf"), "合同.pdf", "application/pdf", 524288L),
          pickFile = { pickedClicked = true },
        )
      }
    }
    compose.onNodeWithText("📄 周报.pdf · 1.50 MB").assertExists()
    compose.onNodeWithText("已保存至：下载/AnyLink/周报.pdf").assertExists()
    compose.onNodeWithText("打开文件").assertExists()
    compose.onNodeWithText("分享").assertExists()
    compose.onNodeWithText("📎 合同.pdf（512.0 KB）").assertExists()
    compose.onNodeWithText("发文件").assertExists()

    System.getenv("ANYLINK_SCREENSHOT_DIR")?.let { directory ->
      val file = java.io.File(directory, "android-file-transfer-v09.png"); file.parentFile?.mkdirs()
      file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    compose.onNodeWithText("📎").performClick()
    assertTrue(pickedClicked)
    compose.onNodeWithText("发文件").performClick()
    assertTrue(sentTriggered)
  }
}
