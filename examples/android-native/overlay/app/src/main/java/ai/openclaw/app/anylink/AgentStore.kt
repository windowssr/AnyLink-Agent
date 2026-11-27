package ai.openclaw.app.anylink

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.json.*

internal interface AgentLedger {
  fun timeline(): JsonArray? = null
  fun timeline(value: JsonArray) {}
  fun messages(): JsonArray
  fun messages(value: JsonArray)
  fun runs(): List<JsonObject>
  fun run(id: String, value: JsonObject)
  fun operation(id: String): JsonObject?
  fun operation(id: String, value: JsonObject)
  fun workerTask(id: String): JsonObject?
  fun workerTask(id: String, value: JsonObject)
  fun workerTasks(): List<JsonObject>
  fun saveNote(name: String, content: String)
  fun readNote(name: String): String?
  fun enqueueMemoryOutbox(id: String, payload: JsonObject) {}
  fun memoryOutbox(): List<Pair<String, JsonObject>> = emptyList()
  fun removeMemoryOutbox(id: String) {}
}
private class LinkDatabase(context: Context, name: String) : SQLiteOpenHelper(context, name, null, 1) {
  override fun onCreate(db: SQLiteDatabase) {
    db.execSQL("CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id))")
  }
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
}
internal class SqlAgentLedger(context: Context, connection: CloudConnection) : AgentLedger {
  private val binding = MessageDigest.getInstance("SHA-256").digest("${connection.server}|${connection.deviceId}".toByteArray()).joinToString("") { "%02x".format(it) }
  private val database = LinkDatabase(context, "anylink-agent-$binding.db")
  init {
    // A process death never resumes inference or repeats a submitted tool.
    for (run in runs()) if (run.text("state") == "running") {
      run(run.text("id"), JsonObject(run + mapOf("state" to str("unknown"), "notice" to str("上次运行被中断，结果可能未知；没有自动重跑。"))))
    }
  }
  @Synchronized private fun get(kind: String, id: String): String? = database.readableDatabase.query("records", arrayOf("value"), "kind=? AND id=?", arrayOf(kind, id), null, null, null).use { if (it.moveToFirst()) it.getString(0) else null }
  @Synchronized private fun set(kind: String, id: String, value: String) {
    val row = ContentValues().apply { put("kind", kind); put("id", id); put("value", value) }
    if (database.writableDatabase.insertWithOnConflict("records", null, row, SQLiteDatabase.CONFLICT_REPLACE) < 0) throw LinkFailure("LOCAL_STORE_FAILURE", "本机记录未持久保存，未继续执行")
  }
  override fun timeline(): JsonArray? = get("session", "timeline")?.let { linkJson.parseToJsonElement(it).jsonArray }
  override fun timeline(value: JsonArray) = set("session", "timeline", value.toString())
  override fun messages(): JsonArray = get("session", "messages")?.let { linkJson.parseToJsonElement(it).jsonArray } ?: JsonArray(emptyList())
  override fun messages(value: JsonArray) = set("session", "messages", value.toString())
  override fun runs(): List<JsonObject> = database.readableDatabase.query("records", arrayOf("value"), "kind=?", arrayOf("run"), null, null, "rowid DESC", "60").use { rows -> buildList { while (rows.moveToNext()) add(linkJson.parseToJsonElement(rows.getString(0)).jsonObject) } }
  override fun run(id: String, value: JsonObject) = set("run", id, value.toString())
  override fun operation(id: String): JsonObject? = get("operation", id)?.let { linkJson.parseToJsonElement(it).jsonObject }
  override fun operation(id: String, value: JsonObject) = set("operation", id, value.toString())
  override fun workerTask(id: String): JsonObject? = get("workertask", id)?.let { linkJson.parseToJsonElement(it).jsonObject }
  override fun workerTask(id: String, value: JsonObject) = set("workertask", id, value.toString())
  override fun workerTasks(): List<JsonObject> = database.readableDatabase.query("records", arrayOf("value"), "kind=?", arrayOf("workertask"), null, null, "rowid DESC", "200").use { rows -> buildList { while (rows.moveToNext()) add(linkJson.parseToJsonElement(rows.getString(0)).jsonObject) } }
  override fun saveNote(name: String, content: String) = set("note", name, content)
  override fun readNote(name: String): String? = get("note", name)

  @Synchronized override fun enqueueMemoryOutbox(id: String, payload: JsonObject) {
    set("memory_outbox", id, payload.toString())
    // Enforce 100-item FIFO cap.
    val existing = database.readableDatabase.query("records", arrayOf("id"), "kind=?", arrayOf("memory_outbox"), null, null, "rowid ASC").use { rows ->
      buildList { while (rows.moveToNext()) add(rows.getString(0)) }
    }
    if (existing.size > 100) {
      for (dropId in existing.take(existing.size - 100)) {
        database.writableDatabase.delete("records", "kind=? AND id=?", arrayOf("memory_outbox", dropId))
      }
    }
  }

  @Synchronized override fun memoryOutbox(): List<Pair<String, JsonObject>> =
    database.readableDatabase.query("records", arrayOf("id", "value"), "kind=?", arrayOf("memory_outbox"), null, null, "rowid ASC", "100").use { rows ->
      buildList {
        while (rows.moveToNext()) {
          val parsed = runCatching { linkJson.parseToJsonElement(rows.getString(1)).jsonObject }.getOrNull() ?: continue
          add(rows.getString(0) to parsed)
        }
      }
    }

  @Synchronized override fun removeMemoryOutbox(id: String) {
    database.writableDatabase.delete("records", "kind=? AND id=?", arrayOf("memory_outbox", id))
  }
}
/** Token ciphertext stays in app-private SQLite; the encryption key never leaves Android Keystore. */
internal class ConnectionStore(context: Context) {
  private val database = LinkDatabase(context, "anylink-connection.db")
  private val alias = "anylink-device-credential-v1"
  private fun key(): SecretKey {
    val keys = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return (keys.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  fun save(connection: CloudConnection) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val secret = cipher.doFinal(connection.token.toByteArray())
    val value = buildJsonObject { put("server", connection.server); put("device_id", connection.deviceId); put("agent_id", connection.agentId); put("install_id", connection.installId); put("device_slug", connection.deviceSlug); put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)); put("encrypted_token", Base64.encodeToString(secret, Base64.NO_WRAP)) }
    database.writableDatabase.insertWithOnConflict("records", null, ContentValues().apply { put("kind", "connection"); put("id", "active"); put("value", value.toString()) }, SQLiteDatabase.CONFLICT_REPLACE)
    if (connection.installId.isNotBlank()) database.writableDatabase.insertWithOnConflict("records", null, ContentValues().apply { put("kind", "install"); put("id", "android"); put("value", connection.installId) }, SQLiteDatabase.CONFLICT_REPLACE)
  }
  fun installId(): String? = database.readableDatabase.query("records", arrayOf("value"), "kind=? AND id=?", arrayOf("install", "android"), null, null, null).use { if (it.moveToFirst()) it.getString(0) else null }
  fun load(): CloudConnection? = database.readableDatabase.query("records", arrayOf("value"), "kind=? AND id=?", arrayOf("connection", "active"), null, null, null).use { rows ->
    if (!rows.moveToFirst()) return@use null
    val data = linkJson.parseToJsonElement(rows.getString(0)).jsonObject
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(data.text("iv"), Base64.NO_WRAP))) }
    CloudConnection(data.text("server"), cipher.doFinal(Base64.decode(data.text("encrypted_token"), Base64.NO_WRAP)).decodeToString(), data.text("device_id"), data.text("agent_id"), data.text("install_id"), data.text("device_slug"))
  }
  fun clear() { database.writableDatabase.delete("records", "kind=?", arrayOf("connection")) }
}
