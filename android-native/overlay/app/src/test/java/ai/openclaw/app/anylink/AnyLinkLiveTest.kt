package ai.openclaw.app.anylink

import java.io.File
import java.util.UUID
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Opt-in real cloud proof. Never selected by the regular test task. No Gateway is used. */
class AnyLinkLiveTest {
  @Test fun `native phone loop uses real model unified memory and cloud Mac task relay`() = runBlocking {
    val input = File(requireNotNull(System.getenv("ANYLINK_LIVE_CONNECTION_FILE"))).readText()
    val config = linkJson.parseToJsonElement(input).jsonObject
    val connection = CloudConnection.parse(config.text("server"), input)
    val cloud = CloudClient(connection)
    val marker = requireNotNull(System.getenv("ANYLINK_LIVE_MARKER"))
    require(Regex("AL_DEVICE_[a-f0-9-]+").matches(marker))
    val report = mutableListOf<String>()
    val ledger = MemoryLedger()
    val agent = DeviceAgent(connection, cloud, ledger, { jsonObject("runtime" to str("android-native-agent-jvm-proof"), "device_id" to str(connection.deviceId), "hardware_verified" to JsonPrimitive(false)) })
    suspend fun facts(): List<JsonObject> = cloud.request("POST", "/edge/v1/memories/search", jsonObject("q" to str(marker)))["items"]!!.jsonArray.map { it.jsonObject }.filter { it.text("source_device_id") == connection.deviceId && it.text("title").startsWith(marker) }
    try {
      agent.send("请调用device_info，简短说明返回的runtime和device_id。不要保存记忆，不要调用跨设备任务。")
      assertEquals("completed", ledger.runs().first().text("state")); assertTrue(ledger.operations.values.any { it.toString().contains("android-native-agent-jvm-proof") }); report.add("native local tool round through real model without Gateway")
      agent.send("请记住本次测试的两条事实，各用memory_save保存：global，标题${marker}_G，内容‘全局校验值是${marker}_GLOBAL’；device，标题${marker}_D，内容‘手机校验值是${marker}_DEVICE’。只保存这两条，简短回答。")
      val saved = facts(); assertEquals(2, saved.size)
      assertTrue(saved.any { it.text("scope") == "global" }); assertTrue(saved.any { it.text("scope") == "device" && it.text("applicable_device_id") == connection.deviceId }); report.add("global and phone facts persisted with authenticated phone provenance")
      val freshLedger = MemoryLedger(); val fresh = DeviceAgent(connection, cloud, freshLedger, { JsonObject(emptyMap()) })
      fresh.send("本次测试的全局校验值和手机校验值分别是什么？根据当前云端记忆回答，不要写记忆。")
      val answer = freshLedger.runs().first().text("answer"); assertTrue(answer.contains(marker + "_GLOBAL")); assertTrue(answer.contains(marker + "_DEVICE")); report.add("fresh native conversation recalls unified memory")
      agent.send("帮我在已授权Mac的workspace范围搜索文件名包含 $marker 的文件。请用link_peers和task_create，capability为files.search，input只需query和scope。不读正文，不写文件或记忆。")
      val created = cloud.request("GET", "/edge/v1/link/tasks")["items"]!!.jsonArray.map { it.jsonObject }.filter { it.text("capability") == "files.search" && it["input"]?.toString()?.contains(marker) == true }
      assertEquals("Only one task should be created", 1, created.size)
      var task = created.first()
      for (attempt in 1..20) {
        if (task.text("state") in setOf("succeeded", "failed", "unknown", "cancelled", "expired")) break
        delay(1500); task = cloud.request("GET", "/edge/v1/link/tasks/${task.text("id")}")
      }
      assertEquals("succeeded", task.text("state")); assertTrue(task["result"]!!.toString().contains(marker + ".txt")); report.add("phone to cloud to local Mac worker and real search receipt")
      File(requireNotNull(System.getenv("ANYLINK_LIVE_REPORT"))).writeText(buildJsonObject { put("passed", true); put("hardware_verified", false); put("gateway_used", false); put("checks", JsonArray(report.map(::str))); put("task_id", task.text("id")) }.toString())
    } finally {
      for (fact in facts()) cloud.request("DELETE", "/edge/v1/memories/${fact.text("id")}", key = UUID.randomUUID().toString(), revision = fact["revision"]!!.jsonPrimitive.int)
    }
  }
}
