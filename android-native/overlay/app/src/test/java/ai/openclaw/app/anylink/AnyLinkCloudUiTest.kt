package ai.openclaw.app.anylink

import android.content.Intent
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithText
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
  @Test fun `launcher and setup belong to the local agent not OpenClaw pairing`() {
    val app = RuntimeEnvironment.getApplication()
    val launch = app.packageManager.getLaunchIntentForPackage(app.packageName)
    assertEquals("ai.openclaw.app.anylink.AnyLinkActivity", launch?.component?.className)
    val permissions = app.packageManager.getPackageInfo(app.packageName, android.content.pm.PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty()
    assertFalse(permissions.contains("android.permission.READ_SMS")); assertFalse(permissions.contains("android.permission.ACCESS_BACKGROUND_LOCATION"))
    assertNull(app.packageManager.resolveActivity(Intent().setClassName(app, "ai.openclaw.app.MainActivity"), 0))
    compose.setContent {
      MaterialTheme {
        CloudCompanionScreen(LocalAgentState(), null, "", "", false, false, false, emptyList(), true, {}, {}, { _, _, _, _ -> }, {}, {}, {}, {})
      }
    }
    compose.onNodeWithText("连接 AnyLink 服务器").assertExists()
    compose.onNodeWithText("HTTPS 服务器地址").assertExists()
    compose.onNodeWithText("加入密钥").assertExists()
    compose.onNodeWithText("导入旧版设备凭据 JSON").performClick()
    compose.onNodeWithText("设备凭据 JSON").assertExists()
    compose.onNodeWithText("连接我的 Mac").assertDoesNotExist()
    System.getenv("ANYLINK_SCREENSHOT_DIR")?.let { directory ->
      val file = java.io.File(directory, "android-server-connection.png"); file.parentFile?.mkdirs()
      file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
  }
  @Test fun `cloud file results show real filenames and coverage instead of internal JSON`() {
    val task = linkJson.parseToJsonElement("""{"id":"33333333-3333-4333-8333-333333333333","capability":"files.search","state":"succeeded","result":{"state":"succeeded","output":{"matches":[{"name":"report.txt","path":"/Workspace/report.txt"}],"partial":true}}}""").jsonObject
    compose.setContent {
      MaterialTheme { CloudCompanionScreen(LocalAgentState(), "https://example.invalid", "", "", false, false, false, listOf(task), false, {}, {}, { _, _, _, _ -> }, {}, {}, {}, {}) }
    }
    compose.onNodeWithText("任务与记录").performClick()
    compose.onNodeWithText("report.txt").assertExists()
    compose.onNodeWithText("/Workspace/report.txt").assertExists()
    compose.onNodeWithText("搜索覆盖有限，未遍历全部文件。").assertExists()
  }

}
